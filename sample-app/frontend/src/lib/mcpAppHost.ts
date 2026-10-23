// =============================================================================
// lib/mcpAppHost.ts — a tiny MCP Apps *host* (the part GitHub Copilot plays)
// -----------------------------------------------------------------------------
// An MCP App is an HTML page that a tool points at through
// `_meta.ui.resourceUri`. A host has to:
//
//   1. read that ui:// resource from the server (resources/read),
//   2. run it in a sandboxed iframe with a Content-Security-Policy built from
//      the resource's `_meta.ui.csp`, so it can only reach what it declared,
//   3. talk JSON-RPC to the iframe over postMessage:
//
//        view → host  ui/initialize                  handshake; host replies with theme + capabilities
//        view → host  ui/notifications/initialized   "I am ready"
//        host → view  ui/notifications/tool-input    the arguments of the tool call
//        host → view  ui/notifications/tool-result   the result of the tool call
//        view → host  tools/call                     view asks the server for more (host proxies it)
//        view → host  ui/notifications/size-changed  so the host can resize the iframe
//        view → host  ui/update-model-context        tells the AI what the user is looking at
//        host → view  ui/resource-teardown           "you are being closed, clean up"
//
// This ~200-line version is here so the moving parts are readable, and as a
// "plan B" when no AI host is available. It is not a hardened host: for a real
// product use the AppBridge from the official @modelcontextprotocol/ext-apps.
// =============================================================================

import type { McpClient, McpTool } from './mcpClient';

export type HostLog = (text: string, level?: 'info' | 'good' | 'bad' | 'muted') => void;

export type HostOptions = {
  client: McpClient;
  container: HTMLElement;
  /** The tool whose result the app renders (it carries `_meta.ui.resourceUri`). */
  tool: McpTool;
  /** Everything the server offers, so the host can enforce tool visibility. */
  tools: McpTool[];
  args: Record<string, unknown>;
  log: HostLog;
};

type Rpc = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
};

const PROTOCOL_VERSION = '2026-01-26';
const APP_MIME = 'text/html;profile=mcp-app';

export function toolUiUri(tool: McpTool): string | undefined {
  const uri = tool._meta?.ui?.resourceUri ?? tool._meta?.['ui/resourceUri'];
  return typeof uri === 'string' && uri.startsWith('ui://') ? uri : undefined;
}

// `visibility` says who may call a tool: the model, the app, or both (default).
function appMayCall(tool: McpTool | undefined): boolean {
  if (!tool) return false;
  const visibility = tool._meta?.ui?.visibility;
  return !Array.isArray(visibility) || visibility.includes('app');
}

// Only plain origins go into the policy. A server must not be able to smuggle
// extra directives in through a "domain" such as "x; script-src *".
const SAFE_SOURCE = /^(https?|wss?):\/\/(\*\.)?([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:\d{1,5})?$/;

function safeSources(list: unknown): string[] {
  return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string' && SAFE_SOURCE.test(s)) : [];
}

// Default from the spec: nothing may leave the sandbox. The app opts in per domain.
function buildCsp(csp: { connectDomains?: unknown; resourceDomains?: unknown } | undefined): string {
  const connect = safeSources(csp?.connectDomains).join(' ') || "'none'";
  const resources = safeSources(csp?.resourceDomains).join(' ');
  const withResources = (base: string) => `${base} ${resources}`.trim();
  return [
    "default-src 'none'",
    withResources("script-src 'self' 'unsafe-inline'"),
    withResources("style-src 'self' 'unsafe-inline'"),
    withResources("img-src 'self' data:"),
    withResources("font-src 'self'"),
    `connect-src ${connect}`,
  ].join('; ');
}

// A blob: URL has no response headers, so the policy travels in a <meta> tag
// placed first in <head>, before any of the app's own scripts.
function injectCsp(html: string, csp: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (open) => open + meta) : meta + html;
}

// Hand the app our look: the MCP Apps spec defines the CSS variable names.
function hostStyleVariables(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    '--color-background-primary': v('--panel', '#161a22'),
    '--color-background-secondary': v('--bg', '#0e1015'),
    '--color-background-tertiary': '#1d2230',
    '--color-text-primary': v('--text', '#ecf0f4'),
    '--color-text-secondary': v('--muted', '#9aa5b8'),
    '--color-border-secondary': v('--border', '#2a3140'),
    '--color-text-info': v('--accent', '#5dd9ff'),
    '--color-ring-info': v('--accent', '#5dd9ff'),
    '--color-text-success': v('--good', '#6eea9b'),
    '--color-text-warning': v('--accent2', '#ffd166'),
    '--color-text-danger': v('--bad', '#ff7474'),
    '--font-sans': getComputedStyle(document.body).fontFamily,
    '--font-mono': 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    '--font-text-sm-size': '14px',
    '--font-heading-xs-size': '16px',
    '--font-weight-semibold': '600',
    '--border-radius-md': '8px',
  };
}

export class McpAppHost {
  private frame: HTMLIFrameElement | null = null;
  private blobUrl: string | null = null;
  private waiting = new Map<number, (reply: Rpc) => void>();
  private nextId = 1;
  private started = false;
  private disposed = false;
  private readonly onWindowMessage = (event: MessageEvent) => { void this.handle(event); };

  constructor(private readonly o: HostOptions) {}

  async mount(): Promise<void> {
    const { client, tool, container, log } = this.o;
    const uri = toolUiUri(tool);
    if (!uri) throw new Error(`${tool.name} has no _meta.ui.resourceUri, so there is no app to show.`);

    log(`host: resources/read ${uri}`, 'muted');
    const read = await client.request<{ contents?: Array<{ mimeType?: string; text?: string; _meta?: any }> }>(
      'resources/read', { uri });
    if (this.disposed) return;
    const content = read.contents?.[0];
    if (!content?.text) throw new Error('The server returned an empty resource.');
    if (content.mimeType !== APP_MIME) {
      throw new Error(`Refusing to render ${content.mimeType ?? 'an unknown type'}: an MCP App must be ${APP_MIME}.`);
    }

    const ui = content._meta?.ui ?? {};
    const csp = buildCsp(ui.csp);
    log(`host: sandbox policy ${csp}`, 'muted');

    this.blobUrl = URL.createObjectURL(new Blob([injectCsp(content.text, csp)], { type: 'text/html' }));
    const frame = document.createElement('iframe');
    frame.className = 'mcp-app-frame' + (ui.prefersBorder ? ' bordered' : '');
    frame.title = tool.title ?? tool.name;
    // Scripts only: no same-origin access, no forms, no popups, no top navigation.
    frame.setAttribute('sandbox', 'allow-scripts');
    window.addEventListener('message', this.onWindowMessage);
    frame.src = this.blobUrl;
    this.frame = frame;
    container.replaceChildren(frame);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Give the app a moment to close its streams before the iframe disappears.
    await this.ask('ui/resource-teardown', {}, 500).catch(() => undefined);
    window.removeEventListener('message', this.onWindowMessage);
    this.frame?.remove();
    this.frame = null;
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = null;
  }

  // ---- messages from the app ------------------------------------------------

  private async handle(event: MessageEvent): Promise<void> {
    // The iframe's origin is opaque ("null"), so identify it by window, not by origin.
    if (!this.frame || event.source !== this.frame.contentWindow) return;
    const msg = event.data as Rpc;
    if (!msg || msg.jsonrpc !== '2.0') return;

    if (msg.method && msg.id !== undefined) await this.onRequest(msg);
    else if (msg.method) await this.onNotification(msg);
    else if (typeof msg.id === 'number') this.waiting.get(msg.id)?.(msg);
  }

  private async onRequest(msg: Rpc): Promise<void> {
    const { log, client, tools } = this.o;
    const id = msg.id!;
    try {
      switch (msg.method) {
        case 'ui/initialize':
          log('view → host: ui/initialize (handshake)', 'muted');
          return this.reply(id, {
            protocolVersion: PROTOCOL_VERSION,
            hostInfo: { name: 'RT Demo mini host', version: '1.0.0' },
            hostCapabilities: { serverTools: {}, updateModelContext: { text: {} } },
            hostContext: {
              theme: 'dark',
              styles: { variables: hostStyleVariables() },
              displayMode: 'inline',
              availableDisplayModes: ['inline'],
              platform: 'web',
              locale: navigator.language,
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
          });

        case 'tools/call': {
          const name = String(msg.params?.name ?? '');
          if (!appMayCall(tools.find((t) => t.name === name))) {
            log(`view → host: tools/call ${name} refused (not visible to apps)`, 'bad');
            return this.replyError(id, -32602, `Tool "${name}" is not available to apps.`);
          }
          log(`view → host: tools/call ${name} (proxied to the server)`, 'muted');
          return this.reply(id, await client.request('tools/call', msg.params));
        }

        case 'ui/update-model-context': {
          const text = msg.params?.content?.find?.((c: any) => c.type === 'text')?.text ?? '(structured data)';
          log(`view → host: ui/update-model-context "${text}"`, 'good');
          return this.reply(id, {});
        }

        case 'ui/message':
        case 'ui/open-link':
          log(`view → host: ${msg.method} (ignored by this demo host)`, 'muted');
          return this.reply(id, { isError: true });

        case 'ping':
          return this.reply(id, {});

        default:
          return this.replyError(id, -32601, `Method not found: ${msg.method}`);
      }
    } catch (e: any) {
      this.replyError(id, e?.code ?? -32603, e?.message ?? 'Host error');
    }
  }

  private async onNotification(msg: Rpc): Promise<void> {
    switch (msg.method) {
      case 'ui/notifications/initialized':
        return this.start();

      case 'ui/notifications/size-changed': {
        const height = Number(msg.params?.height);
        if (this.frame && Number.isFinite(height)) {
          this.frame.style.height = `${Math.min(Math.max(Math.ceil(height), 80), 900)}px`;
          this.o.log(`view → host: size-changed ${Math.ceil(height)}px`, 'muted');
        }
        return;
      }
    }
  }

  // The app is ready: give it the tool input, run the tool, hand over the result.
  private async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    const { client, tool, args, log } = this.o;

    log('view → host: initialized', 'muted');
    this.send('ui/notifications/tool-input', { arguments: args });
    log(`host → view: tool-input ${JSON.stringify(args)}`, 'muted');
    log(`host: tools/call ${tool.name}`, 'muted');
    try {
      const result = await client.request('tools/call', { name: tool.name, arguments: args });
      if (this.disposed) return;
      this.send('ui/notifications/tool-result', result);
      log('host → view: tool-result', 'muted');
    } catch (e: any) {
      this.send('ui/notifications/tool-result', {
        isError: true,
        content: [{ type: 'text', text: e?.message ?? 'The tool call failed.' }],
      });
    }
  }

  // ---- plumbing ---------------------------------------------------------------

  // Target origin "*" is required: the sandboxed iframe has an opaque origin.
  // That is safe here because we only ever post to the window we created.
  private post(message: Rpc): void {
    this.frame?.contentWindow?.postMessage({ jsonrpc: '2.0', ...message }, '*');
  }
  private send(method: string, params?: unknown): void { this.post({ method, params }); }
  private reply(id: number | string, result: unknown): void { this.post({ id, result }); }
  private replyError(id: number | string, code: number, message: string): void {
    this.post({ id, error: { code, message } });
  }

  // A request from the host to the app, with a timeout in case the app is gone.
  private ask(method: string, params: unknown, timeoutMs: number): Promise<Rpc> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error('timeout')); }, timeoutMs);
      this.waiting.set(id, (reply) => { clearTimeout(timer); this.waiting.delete(id); resolve(reply); });
      this.post({ id, method, params });
    });
  }
}
