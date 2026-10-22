// =============================================================================
// pages/ComparePage.tsx — telemetry summary across every technology demo
// =============================================================================
import { useEffect, useState } from 'react';
import { authHeader } from '../lib/auth';

type Row = { technology: string; events: number; lastAt: string };

export default function ComparePage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [auto, setAuto] = useState(true);

  async function refresh() {
    const res = await fetch('/api/telemetry/summary', { headers: authHeader() });
    if (!res.ok) return;
    setRows(await res.json());
  }
  useEffect(() => {
    refresh();
    if (!auto) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [auto]);

  return (
    <>
      <h2>Compare — telemetry across technologies</h2>
      <p>
        Every demo on this site calls{' '}
        <code>TelemetryService.Track(technology, eventName, ...)</code> on the
        server. Those calls go to <b>Application Insights</b> (if a connection
        string is configured) <em>and</em> to a local SQLite mirror so you can
        observe activity here with no Azure account.
      </p>

      <div className="card">
        <div className="row">
          <button onClick={refresh}>Refresh</button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            auto-refresh every 2s
          </label>
        </div>

        <table className="compare" style={{ marginTop: 12 }}>
          <thead>
            <tr><th>Technology</th><th>Events</th><th>Last event at</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--muted)' }}>
                no telemetry yet — go exercise the demos
              </td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.technology}>
                <td><b>{r.technology}</b></td>
                <td>{r.events}</td>
                <td>{new Date(r.lastAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Decision matrix</h3>
        <table className="compare">
          <thead>
            <tr>
              <th>Tech</th><th>Direction</th><th>Sweet spot</th><th>Avoid for</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>Short polling</td><td>C↔S</td><td>"Is job done?"</td><td>High freq</td></tr>
            <tr><td>Long polling</td><td>C↔S</td><td>Hostile networks</td><td>Bursty</td></tr>
            <tr><td>HTTP streaming</td><td>S→C (POST)</td><td>LLM tokens</td><td>Needs reconnect</td></tr>
            <tr><td>SSE</td><td>S→C</td><td>Dashboards, feeds</td><td>Chat / games</td></tr>
            <tr><td>WebSockets</td><td>C↔S</td><td>Chat, collab, games</td><td>A/V</td></tr>
            <tr><td>SignalR</td><td>C↔S</td><td>Real-time on .NET</td><td>Non-.NET</td></tr>
            <tr><td>WebRTC</td><td>P↔P</td><td>A/V + P2P data</td><td>Notifications</td></tr>
            <tr><td>Web Push</td><td>S→C bg</td><td>Doorbell</td><td>Bulk data</td></tr>
            <tr><td>PWA</td><td>n/a</td><td>Installable, offline</td><td>Heavy native</td></tr>
            <tr><td>MCP</td><td>AI host↔S</td><td>Tools + UI for AI hosts</td><td>Raw streaming</td></tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
