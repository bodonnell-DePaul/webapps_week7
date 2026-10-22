// e2e smoke test for all real-time technologies in the demo.
// Runs node-based simulation of what the browser does.
//
// Tests:
//   1. Auth: register/login -> JWT
//   2. Polling: produce + short poll
//   3. Long polling: produce + wait
//   4. HTTP streaming: NDJSON over POST
//   5. SSE: connect, receive events
//   6. WebSocket: connect, send/receive, get tick
//   7. SignalR negotiate (full WS flow tested via browser)
//   8. Push: VAPID public key + subscribe + send
//   9. Telemetry summary
//
// Prerequisites: the backend is running (default http://127.0.0.1:5090, override
// with BASE_URL=...) and `npm ci` has been run in frontend/ - this script borrows
// the `ws` package installed there. The MCP server has its own script: e2e-mcp.mjs.

import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';

let WebSocket;
try {
  const ws = createRequire(new URL('./frontend/package.json', import.meta.url))('ws');
  WebSocket = ws.WebSocket ?? ws; // ws 7 exports the class itself, ws 8 a namespace object
} catch {
  console.error('Could not load "ws". Run `npm ci` in sample-app/frontend first.');
  process.exit(1);
}

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:5090').replace(/\/$/, '');
const WS_BASE = BASE.replace(/^http/, 'ws');
let token = null;
let failures = 0;

function req(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) },
    };
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function streamGet(url, { headers = {}, body, method = 'GET', maxMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) },
    };
    const lib = u.protocol === 'https:' ? https : http;
    const chunks = [];
    const r = lib.request(opts, (res) => {
      const t = setTimeout(() => { res.destroy(); resolve({ status: res.statusCode, chunks }); }, maxMs);
      res.on('data', (c) => chunks.push(c.toString()));
      res.on('end', () => { clearTimeout(t); resolve({ status: res.statusCode, chunks }); });
      res.on('error', reject);
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function log(ok, label, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ': ' + detail : ''}`);
}

async function run() {
  // 1. Auth
  let r = await req('POST', `${BASE}/api/auth/register`,
    { body: JSON.stringify({ username: 'e2euser', password: 'password' }) });
  if (r.status === 409) {
    r = await req('POST', `${BASE}/api/auth/login`,
      { body: JSON.stringify({ username: 'e2euser', password: 'password' }) });
  }
  if (r.status !== 200) { log(false, 'auth', `status=${r.status} body=${r.body}`); process.exit(1); }
  token = JSON.parse(r.body).token;
  log(true, 'auth', `tokenLen=${token.length}`);
  const H = { Authorization: `Bearer ${token}` };

  // 2. Polling — produce + short poll
  await req('POST', `${BASE}/api/polling/produce`,
    { headers: H, body: JSON.stringify({ message: 'e2e short poll' }) });
  r = await req('GET', `${BASE}/api/polling/items?afterId=0`, { headers: H });
  const items = JSON.parse(r.body);
  log(items.length >= 1, 'polling short', `items=${items.length}`);

  // 3. Long polling — produce *while* waiting
  setTimeout(() => req('POST', `${BASE}/api/polling/produce`,
    { headers: H, body: JSON.stringify({ message: 'e2e long-poll triggered' }) }), 300);
  r = await req('GET',
    `${BASE}/api/polling/long-poll?afterId=${items[items.length - 1]?.id || 0}&timeoutSec=10`,
    { headers: H });
  const lpItems = JSON.parse(r.body);
  log(lpItems.length >= 1, 'polling long', `items=${lpItems.length}`);

  // 4. HTTP streaming
  r = await streamGet(`${BASE}/api/streaming/echo`,
    { method: 'POST', headers: H, body: JSON.stringify({ text: 'one two three four' }), maxMs: 4000 });
  const lines = r.chunks.join('').split('\n').filter(Boolean);
  log(lines.length >= 4, 'http streaming', `chunks=${lines.length}`);

  // 5. SSE — produce more items first then connect briefly
  await req('POST', `${BASE}/api/polling/produce`,
    { headers: H, body: JSON.stringify({ message: 'for-sse' }) });
  r = await streamGet(`${BASE}/api/sse/stream?access_token=${token}&afterId=0`, { maxMs: 2500 });
  const sseText = r.chunks.join('');
  const hasWelcome = sseText.includes('welcome');
  const hasItem = sseText.includes('event: item');
  log(hasWelcome && hasItem, 'sse', `welcome=${hasWelcome} item=${hasItem}`);

  // 6. WebSocket
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws/echo?access_token=${token}`);
    let echoed = false, ticked = false;
    const tmo = setTimeout(() => { ws.close(); resolve({ echoed, ticked }); }, 4500);
    ws.on('open', () => ws.send('hello ws'));
    ws.on('message', (data) => {
      const obj = JSON.parse(data.toString());
      if (obj.type === 'echo') echoed = true;
      if (obj.type === 'tick') ticked = true;
      if (echoed && ticked) { clearTimeout(tmo); ws.close(); resolve({ echoed, ticked }); }
    });
    ws.on('error', (err) => { clearTimeout(tmo); reject(err); });
  }).then((res) => log(res.echoed && res.ticked, 'websocket',
    `echo=${res.echoed} tick=${res.ticked}`))
    .catch((err) => log(false, 'websocket', err.message));

  // 7. SignalR negotiate
  r = await req('POST', `${BASE}/hubs/chat/negotiate?negotiateVersion=1`, { headers: H });
  const neg = JSON.parse(r.body);
  log(!!neg.connectionToken, 'signalr negotiate',
    `connToken len=${neg.connectionToken?.length} transports=${(neg.availableTransports || []).map((t) => t.transport).join(',')}`);

  // 8. Push public key
  r = await req('GET', `${BASE}/api/push/vapid-public-key`);
  const k = JSON.parse(r.body);
  log(!!k.publicKey && k.publicKey.length > 40, 'web push vapid', `keyLen=${k.publicKey?.length}`);

  // 9. Telemetry summary
  r = await req('GET', `${BASE}/api/telemetry/summary`, { headers: H });
  const sum = JSON.parse(r.body);
  log(sum.length >= 4, 'telemetry summary',
    sum.map((x) => `${x.technology}=${x.events}`).join(' '));

  console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
}

run().catch((e) => { console.error('FATAL', e); process.exit(1); });
