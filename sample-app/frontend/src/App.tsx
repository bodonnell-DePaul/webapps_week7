// =============================================================================
// App.tsx — top-level shell: nav + routes
// =============================================================================
import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { clearAuth, getUser } from './lib/auth';
import Home from './pages/Home';
import Login from './pages/Login';
import PollingPage from './pages/PollingPage';
import HttpStreamingPage from './pages/HttpStreamingPage';
import SsePage from './pages/SsePage';
import WebSocketPage from './pages/WebSocketPage';
import SignalRPage from './pages/SignalRPage';
import WebRTCPage from './pages/WebRTCPage';
import PushPage from './pages/PushPage';
import PwaPage from './pages/PwaPage';
import McpPage from './pages/McpPage';
import ComparePage from './pages/ComparePage';

export default function App() {
  const [user, setUser] = useState(getUser());
  const navigate = useNavigate();

  useEffect(() => {
    // Listen for storage changes so logging out in one tab logs out everywhere.
    const onStorage = () => setUser(getUser());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  function logout() {
    clearAuth();
    setUser(null);
    navigate('/login');
  }

  // If not logged in, show only the login page.
  if (!user) {
    return (
      <div className="app" style={{ gridTemplateColumns: '1fr' }}>
        <main>
          <h2>Week 8 — Realtime Demo</h2>
          <Login onAuthed={(u) => setUser(u)} />
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <nav className="side">
        <h1>RT Demo (Week 8)</h1>
        <div className="user">
          Signed in as <b>{user.username}</b>
          <button
            className="secondary"
            style={{ marginLeft: 8, padding: '2px 8px', fontSize: 12 }}
            onClick={logout}
          >
            Sign out
          </button>
        </div>
        <ul>
          <li><NavLink to="/" end>🏠 Home</NavLink></li>
          <li><NavLink to="/polling">🔁 Polling <span className="tag">short + long</span></NavLink></li>
          <li><NavLink to="/streaming">🌊 HTTP Streaming <span className="tag">NDJSON</span></NavLink></li>
          <li><NavLink to="/sse">📡 SSE <span className="tag">EventSource</span></NavLink></li>
          <li><NavLink to="/websocket">🔌 WebSocket <span className="tag">raw</span></NavLink></li>
          <li><NavLink to="/signalr">⚡ SignalR <span className="tag">hub</span></NavLink></li>
          <li><NavLink to="/webrtc">🎥 WebRTC <span className="tag">P2P data</span></NavLink></li>
          <li><NavLink to="/push">🔔 Web Push <span className="tag">VAPID</span></NavLink></li>
          <li><NavLink to="/pwa">📱 PWA <span className="tag">install + offline</span></NavLink></li>
          <li><NavLink to="/mcp-demo">🧩 MCP <span className="tag">tools + apps</span></NavLink></li>
          <li><NavLink to="/compare">📊 Compare</NavLink></li>
        </ul>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/polling" element={<PollingPage />} />
          <Route path="/streaming" element={<HttpStreamingPage />} />
          <Route path="/sse" element={<SsePage />} />
          <Route path="/websocket" element={<WebSocketPage />} />
          <Route path="/signalr" element={<SignalRPage />} />
          <Route path="/webrtc" element={<WebRTCPage />} />
          <Route path="/push" element={<PushPage />} />
          <Route path="/pwa" element={<PwaPage />} />
          <Route path="/mcp-demo" element={<McpPage />} />
          <Route path="/compare" element={<ComparePage />} />
        </Routes>
      </main>
    </div>
  );
}
