// =============================================================================
// pages/McpPage.tsx — Model Context Protocol (MCP) + MCP Apps   (lecture §16–§18)
// -----------------------------------------------------------------------------
// The backend is also an MCP server at /mcp (see backend Mcp/*.cs). An AI host
// such as GitHub Copilot connects to it, calls its tools and renders its MCP
// App. This page does three jobs:
//
//   1. Shows how to connect an AI host. This is the main class demo.
//   2. Shows what the server is doing, live, over SignalR. The job events the
//      MCP App receives over SSE reach this page too: one tool call, three
//      real-time channels (lecture §18).
//   3. Plan B: a tiny MCP client and MCP Apps host that run in this page, so
//      the whole flow can still be shown when no AI host is available.
// =============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { HubConnectionBuilder, LogLevel } from '@microsoft/signalr';
import { getToken } from '../lib/auth';
import { useLog, type LogEntry } from '../lib/useLog';
import { McpClient, type Direction, type McpTool } from '../lib/mcpClient';
import { McpAppHost, toolUiUri } from '../lib/mcpAppHost';

// AI hosts such as Copilot connect to the backend directly, so this is the
// backend's port (5090), not the Vite dev server's.
const MCP_URL = 'http://localhost:5090/mcp';
const CLI_COMMAND = `copilot mcp add --transport http realtime-demo ${MCP_URL}`;
const CONFIG_JSON = `{
  "mcpServers": {
    "realtime-demo": {
      "type": "http",
      "url": "${MCP_URL}",
      "tools": ["*"]
    }
  }
}`;
const PROMPTS = [
  'Start a 15 second export of the orders dataset.',
  'Cancel that export.',
  'Send "Hello from Copilot" to the class chat.',
  'Show me the telemetry summary from the demo app.',
];

type JobSnapshot = {
  jobId: string;
  dataset: string;
  status: string;
  percent: number;
  processedRows: number;
  totalRows: number;
};
type McpEvent = { kind: 'tool' | 'job'; name: string; message: string; at: string; data?: JobSnapshot };
type HubState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

// One readable line per JSON-RPC message; the raw JSON is one checkbox away.
function describe(direction: Direction, m: any, raw: boolean): string {
  if (raw) return `${direction === 'out' ? '→' : '←'} ${JSON.stringify(m).slice(0, 1500)}`;
  if (direction === 'out') {
    const detail = m.params?.name ?? m.params?.uri ?? '';
    return `→ ${m.method}${detail ? ` ${detail}` : ''}`;
  }
  if (m.error) return `← error ${m.error.code}: ${m.error.message}`;
  const r = m.result ?? {};
  if (r.serverInfo) return `← ${r.serverInfo.name} ${r.serverInfo.version ?? ''}, protocol ${r.protocolVersion}`;
  if (Array.isArray(r.tools)) return `← ${r.tools.length} tools`;
  if (Array.isArray(r.contents)) return `← ${r.contents.length} resource content(s)`;
  const text = r.content?.find?.((c: any) => c.type === 'text')?.text;
  if (text) return `← ${r.isError ? 'tool error' : 'result'}: ${String(text).slice(0, 160)}`;
  return '← ok';
}

// useLog's own <Log/> is re-created on every render, which remounts the box and
// resets its scroll. This page re-renders often, so it shows the entries here.
function LogBox({ entries }: { entries: LogEntry[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [entries]);
  return (
    <div className="log" ref={ref}>
      {entries.map((e, i) => <div key={i} className={`l-${e.level}`}>[{e.time}] {e.text}</div>)}
    </div>
  );
}

function Snippet({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked: the text is selectable anyway */ }
  }
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>{label}</b>
        <button className="secondary snippet-copy" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <pre className="code">{text}</pre>
    </div>
  );
}

export default function McpPage() {
  const activity = useLog();
  const rpc = useLog();
  const [hub, setHub] = useState<HubState>('connecting');
  const [server, setServer] = useState('not connected yet');
  const [tools, setTools] = useState<McpTool[]>([]);
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [raw, setRaw] = useState(false);
  const [job, setJob] = useState<JobSnapshot | null>(null);

  const rawRef = useRef(raw);
  rawRef.current = raw;
  const readyRef = useRef<Promise<McpTool[]> | null>(null);
  const hostRef = useRef<McpAppHost | null>(null);
  const frameBox = useRef<HTMLDivElement | null>(null);

  const client = useMemo(
    () => new McpClient('/mcp', (dir, msg) => rpc.push(describe(dir, msg, rawRef.current), dir === 'out' ? 'info' : 'muted')),
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ---- Live activity over SignalR -------------------------------------------
  // The server calls Clients.All.SendAsync("McpEvent", …) for every tool call and
  // job event. We start on the next tick so React StrictMode's dev-only
  // mount → unmount → mount does not open and instantly abort a connection.
  useEffect(() => {
    const conn = new HubConnectionBuilder()
      .withUrl('/hubs/chat', { accessTokenFactory: () => getToken() ?? '' })
      .withAutomaticReconnect([0, 2000, 5000, 10000])
      .configureLogging(LogLevel.Warning)
      .build();

    conn.on('McpEvent', (e: McpEvent) => {
      const level = e.name === 'failed' ? 'bad' : e.name === 'completed' ? 'good' : 'info';
      activity.push(`${e.kind === 'tool' ? '🛠' : '📦'} ${e.message}`, level);
      if (e.kind === 'job' && e.data) setJob(e.data);
    });
    conn.on('ReceiveMessage', (user: string, text: string) => {
      if (user === 'mcp-assistant') activity.push(`💬 ${user}: ${text}`, 'good');
    });
    conn.onreconnecting(() => setHub('reconnecting'));
    conn.onreconnected(() => setHub('connected'));
    conn.onclose(() => setHub('disconnected'));

    let live = true;
    const timer = setTimeout(() => {
      conn.start()
        .then(() => { if (live) setHub('connected'); })
        .catch((err) => {
          if (!live) return;
          setHub('disconnected');
          activity.push(`SignalR connect failed: ${err?.message ?? err}`, 'bad');
        });
    }, 0);
    return () => { live = false; clearTimeout(timer); void conn.stop(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { void hostRef.current?.dispose(); }, []);

  // ---- In-browser MCP client ------------------------------------------------
  // initialize → notifications/initialized → tools/list, once per page visit.
  function ensureReady(): Promise<McpTool[]> {
    readyRef.current ??= (async () => {
      const init = await client.initialize();
      const info = init.serverInfo;
      setServer(`${info?.title ?? info?.name ?? 'server'} ${info?.version ?? ''}, protocol ${init.protocolVersion}`.trim());
      const list = await client.request<{ tools: McpTool[] }>('tools/list');
      setTools(list.tools);
      return list.tools;
    })().catch((e) => { readyRef.current = null; throw e; });
    return readyRef.current;
  }

  async function run(label: string, work: () => Promise<void>) {
    setBusy(true);
    try { await work(); }
    catch (e: any) { rpc.push(`${label} failed: ${e?.message ?? e}`, 'bad'); }
    finally { setBusy(false); }
  }

  // The reply is logged by the client's trace hook, so nothing else to do here.
  async function callTool(name: string, args: Record<string, unknown> = {}) {
    await ensureReady();
    await client.request('tools/call', { name, arguments: args });
  }

  const connect = () => run('connect', async () => {
    const list = await ensureReady();
    rpc.push(`server offers ${list.length} tools`, 'good');
  });
  const startExport = () => run('start_export', () =>
    callTool('start_export', { dataset: 'orders', rows: 20000, durationSeconds: 15 }));
  const telemetry = () => run('get_telemetry_summary', () => callTool('get_telemetry_summary'));

  const preview = () => run('preview', async () => {
    const all = await ensureReady();
    const tool = all.find((t) => t.name === 'start_export');
    if (!tool || !toolUiUri(tool) || !frameBox.current) {
      throw new Error('The server did not advertise an MCP App on start_export.');
    }
    await hostRef.current?.dispose();
    const host = new McpAppHost({
      client,
      container: frameBox.current,
      tool,
      tools: all,
      args: { dataset: 'orders', rows: 20000, durationSeconds: 15 },
      log: rpc.push,
    });
    hostRef.current = host;
    setPreviewing(true);
    await host.mount();
  });

  async function closePreview() {
    await hostRef.current?.dispose();
    hostRef.current = null;
    setPreviewing(false);
    if (frameBox.current) frameBox.current.replaceChildren();
  }

  return (
    <>
      <h2>MCP — tools and apps for AI hosts</h2>
      <p>
        This backend is also an <b>MCP server</b> at <code>/mcp</code>. An AI host such as
        GitHub Copilot calls its tools, and one of them, <code>start_export</code>, comes with an{' '}
        <b>MCP App</b>: a live progress view the host shows inline in the chat. The same job
        events reach the app over SSE and this page over SignalR, so one tool call uses three
        real-time channels.
      </p>

      <div className="card">
        <h3>1. Connect an AI host</h3>
        <p>
          Start the backend (port 5090), register the server with Copilot in either way, turn on
          Copilot's <b>Inline MCP Apps</b> feature, then start a new session.
        </p>
        <Snippet label="Command line" text={CLI_COMMAND} />
        <Snippet label=".github/mcp.json (already in this repo)" text={CONFIG_JSON} />
        <p style={{ marginBottom: 4 }}>Then ask Copilot, for example:</p>
        <ul style={{ marginTop: 0 }}>
          {PROMPTS.map((p) => <li key={p}><code>{p}</code></li>)}
        </ul>
      </div>

      <div className="card">
        <h3>2. Live server activity</h3>
        <p>
          Every tool call and job event is pushed here over SignalR
          (<code>McpEvent</code>), whichever client triggered it.
        </p>
        <div className="row">
          <div className="metric">SignalR <strong>{hub}</strong></div>
          {job && <div className="metric">latest job <strong>{job.jobId}</strong></div>}
          {job && <div className="metric">status <strong>{job.status}</strong></div>}
          {job && <div className="metric">progress <strong>{job.percent.toFixed(0)}%</strong></div>}
          <button className="secondary" onClick={activity.clear}>Clear</button>
        </div>
        <LogBox entries={activity.entries} />
      </div>

      <div className="card">
        <h3>3. Plan B: an MCP client and apps host inside this page</h3>
        <p>
          No AI host handy? These buttons speak the same JSON-RPC to <code>/mcp</code> that Copilot
          does, and <b>Show the app</b> plays the host's part: it fetches the <code>ui://</code> view,
          runs it in a sandboxed iframe and relays its messages (source: <code>lib/mcpAppHost.ts</code>).
        </p>
        <div className="row">
          <button onClick={connect} disabled={busy}>Connect and list tools</button>
          <button onClick={startExport} disabled={busy}>Start 15 s export (text only)</button>
          <button onClick={telemetry} disabled={busy}>Telemetry summary</button>
          <button onClick={previewing ? closePreview : preview} disabled={busy}>
            {previewing ? 'Close the app' : 'Show the app'}
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} />
            raw JSON-RPC
          </label>
          <button className="secondary" onClick={rpc.clear}>Clear</button>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <div className="metric">server <strong>{server}</strong></div>
        </div>

        {tools.length > 0 && (
          <table className="compare" style={{ marginTop: 12 }}>
            <thead><tr><th>Tool</th><th>What it does</th><th>App</th></tr></thead>
            <tbody>
              {tools.map((t) => (
                <tr key={t.name}>
                  <td><code>{t.name}</code></td>
                  <td>{t.description?.split('. ')[0]}</td>
                  <td>
                    {toolUiUri(t) ? 'renders a view' : t._meta?.ui?.visibility?.join() === 'app' ? 'app only' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div ref={frameBox} />
        <LogBox entries={rpc.entries} />
      </div>
    </>
  );
}
