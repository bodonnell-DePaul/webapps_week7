// =============================================================================
// lib/mcpClient.ts — a minimal MCP client for the "Streamable HTTP" transport
// -----------------------------------------------------------------------------
// MCP is JSON-RPC 2.0. Over Streamable HTTP every client message is one POST to
// a single endpoint (/mcp). The reply is either a plain JSON body or a short
// text/event-stream that carries the JSON-RPC response.
//
// This is deliberately tiny so students can see there is no magic. Real clients
// use the official SDK, which also handles sessions, resumption and auth. Our
// server is stateless, so there is no Mcp-Session-Id header to track.
// =============================================================================

export type Direction = 'out' | 'in';
export type Trace = (direction: Direction, message: any) => void;

/** The parts of an MCP tool definition this demo looks at. */
export type McpTool = {
  name: string;
  title?: string;
  description?: string;
  _meta?: { ui?: { resourceUri?: string; visibility?: string[] }; [key: string]: unknown };
};

export class McpError extends Error {
  constructor(message: string, readonly code = -32000, readonly data?: unknown) {
    super(message);
    this.name = 'McpError';
  }
}

const HEADERS = {
  'Content-Type': 'application/json',
  // The server picks per request: SSE when it wants to stream, JSON otherwise.
  Accept: 'application/json, text/event-stream',
};

export class McpClient {
  private nextId = 1;

  constructor(private readonly endpoint = '/mcp', private readonly trace?: Trace) {}

  /** The lifecycle every MCP session starts with: initialize, then "initialized". */
  async initialize() {
    const result = await this.request<{
      protocolVersion: string;
      serverInfo?: { name?: string; title?: string; version?: string };
      instructions?: string;
    }>('initialize', {
      protocolVersion: '2025-11-25',
      clientInfo: { name: 'rt-demo-web', version: '1.0.0' },
      // Tells the server this client can render MCP Apps (html + the mcp-app profile).
      capabilities: {
        extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } },
      },
    });
    await this.notify('notifications/initialized');
    return result;
  }

  async request<T = any>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    this.trace?.('out', message);

    const replies = await readMessages(await this.post(message));
    const reply = replies.find((m) => m.id === id);
    if (!reply) throw new McpError('The server sent no response to the request.');
    this.trace?.('in', reply);
    if (reply.error) throw new McpError(reply.error.message, reply.error.code, reply.error.data);
    return reply.result as T;
  }

  /** Notifications have no id and no reply: the server just answers 202 Accepted. */
  async notify(method: string, params?: unknown): Promise<void> {
    const message = { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) };
    this.trace?.('out', message);
    await this.post(message);
  }

  private async post(message: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.endpoint, { method: 'POST', headers: HEADERS, body: JSON.stringify(message) });
    } catch {
      throw new McpError('Could not reach the MCP endpoint. Is the backend running on port 5090?');
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).trim().slice(0, 200);
      throw new McpError(`HTTP ${res.status} ${res.statusText}${detail ? ` - ${detail}` : ''}`, res.status);
    }
    return res;
  }
}

// A reply is JSON, or SSE where each event's `data:` lines hold one JSON-RPC message.
async function readMessages(res: Response): Promise<any[]> {
  const text = await res.text();
  if (!text.trim()) return [];
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const json = JSON.parse(text);
    return Array.isArray(json) ? json : [json];
  }
  return text.split(/\r?\n\r?\n/).flatMap((event) => {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    try { return data ? [JSON.parse(data)] : []; } catch { return []; }
  });
}
