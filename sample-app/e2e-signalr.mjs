// SignalR hub end-to-end smoke test using the official client library.
// Prerequisites: the backend is running (default http://127.0.0.1:5090, override
// with BASE_URL=...) and `npm ci` has been run in frontend/, which provides the client.
import http from 'node:http';
import { createRequire } from 'node:module';

let HubConnectionBuilder, LogLevel;
try {
  ({ HubConnectionBuilder, LogLevel } =
    createRequire(new URL('./frontend/package.json', import.meta.url))('@microsoft/signalr'));
} catch {
  console.error('Could not load "@microsoft/signalr". Run `npm ci` in sample-app/frontend first.');
  process.exit(1);
}

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:5090').replace(/\/$/, '');

function req(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) },
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function login() {
  let r = await req('POST', `${BASE}/api/auth/register`,
    { body: JSON.stringify({ username: 'sruser', password: 'password' }) });
  if (r.status === 409) {
    r = await req('POST', `${BASE}/api/auth/login`,
      { body: JSON.stringify({ username: 'sruser', password: 'password' }) });
  }
  return JSON.parse(r.body).token;
}

const token = await login();
console.log('logged in token len', token.length);

const conn = new HubConnectionBuilder()
  .withUrl(`${BASE}/hubs/chat`, { accessTokenFactory: () => token })
  .configureLogging(LogLevel.Warning)
  .build();

let gotMessage = false;
conn.on('Welcome', (connectionId) => {
  console.log(`✓ Welcome event: connection ${String(connectionId).slice(0, 8)}...`);
});
conn.on('ReceiveMessage', (user, text) => {
  console.log(`✓ ReceiveMessage event: ${user}: ${text}`);
  gotMessage = true;
});

await conn.start();
console.log('✓ hub connected, transport:', conn.connection?.transport?.constructor?.name);

await conn.invoke('SendMessage', 'hello from SignalR e2e');
console.log('✓ SendMessage invoked');

const history = await conn.invoke('GetHistory', 10);
console.log('✓ GetHistory returned', history.length, 'rows');

// Wait briefly to receive the broadcast.
await new Promise((r) => setTimeout(r, 1000));

if (!gotMessage) console.log('✗ did not receive own broadcast');
else console.log('✓ broadcast loopback OK');

await conn.stop();
console.log('✓ hub stopped');
process.exit(gotMessage ? 0 : 1);
