// =============================================================================
// pages/Home.tsx
// =============================================================================
export default function Home() {
  return (
    <>
      <h2>Welcome to the Week 8 Realtime Demo</h2>
      <p>
        Every page in the sidebar demonstrates one technology from the lecture.
        Each demo is heavily commented in the source code, and emits{' '}
        <b>Application Insights</b>-tagged telemetry events that are also stored
        locally in the SQLite database so you can inspect them on{' '}
        <a href="/compare">the Compare page</a>.
      </p>

      <div className="card">
        <h3>How to read each demo</h3>
        <ul>
          <li>Top of the page — a short reminder of the technology and the architectural shape.</li>
          <li>Middle — buttons that produce events or send messages.</li>
          <li>Bottom — a live log of everything happening, plus a metrics row.</li>
        </ul>
      </div>

      <div className="card">
        <h3>Tip for instructors</h3>
        <p>
          Open two browser windows (or one tab + one incognito) and log in as
          different users to see all peer-to-peer / multi-client behaviors.
        </p>
      </div>

      <div className="card">
        <h3>Architecture summary</h3>
        <table className="compare">
          <thead>
            <tr><th>Layer</th><th>Tech</th></tr>
          </thead>
          <tbody>
            <tr><td>Frontend</td><td>React + Vite + TypeScript + vite-plugin-pwa</td></tr>
            <tr><td>Backend</td><td>ASP.NET Core (.NET 8) — controllers, raw WS, SignalR hub, MCP server</td></tr>
            <tr><td>Persistence</td><td>Entity Framework Core (SQLite)</td></tr>
            <tr><td>Auth</td><td>Basic-auth-style register/login → JWT bearer</td></tr>
            <tr><td>Telemetry</td><td>Application Insights + local DB mirror</td></tr>
            <tr><td>AI integration</td><td>MCP server at <code>/mcp</code> (Streamable HTTP) + an MCP App view — see the MCP page</td></tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
