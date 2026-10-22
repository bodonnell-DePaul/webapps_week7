// MCP and MCP Apps end-to-end smoke test. Uses only Node.js built-ins.
// Prerequisites: the backend is running (default http://127.0.0.1:5090).

import http from 'node:http';

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:5090').replace(/\/$/, '');
const ACCEPT = 'application/json, text/event-stream';
let failures = 0;
let nextId = 1;

function log(ok, label, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `: ${detail}` : ''}`);
}

async function post(message, headers = {}) {
  return fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: ACCEPT, ...headers },
    body: JSON.stringify(message),
  });
}

async function rpc(method, params, headers = {}) {
  const id = nextId++;
  const response = await post({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }, headers);
  const messages = await parseMessages(response);
  return { response, message: messages.find((item) => item.id === id) };
}

async function parseMessages(response) {
  const text = await response.text();
  if (!text.trim()) return [];
  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  return text.split(/\r?\n\r?\n/).flatMap((event) => {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    try { return data ? [JSON.parse(data)] : []; } catch { return []; }
  });
}

function resultOf(reply) {
  if (reply?.error) throw new Error(`${reply.error.code}: ${reply.error.message}`);
  return reply?.result;
}

async function callTool(name, args = {}, headers = {}) {
  const { response, message } = await rpc('tools/call', { name, arguments: args }, headers);
  if (!response.ok) throw new Error(`tools/call ${name}: HTTP ${response.status}`);
  return resultOf(message);
}

function structured(result) {
  return result?.structuredContent ?? {};
}

async function readSse(response, controller, stopAtProgress = false) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  let sawProgress = false;

  function consume() {
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const lines = frame.split(/\r?\n/);
      const id = lines.find((line) => line.startsWith('id:'))?.slice(3).trim();
      const type = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
      const data = lines.filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart()).join('\n');
      if (id && type && data) {
        events.push({ id: Number(id), type, data: JSON.parse(data) });
        if (type === 'progress') sawProgress = true;
      }
    }
  }

  try {
    while (!events.some((event) => ['completed', 'cancelled', 'failed'].includes(event.type))) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      consume();
      if (stopAtProgress && sawProgress) {
        await reader.cancel();
        controller.abort();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return events;
}

function requestWithBadHost() {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE}/mcp`);
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { Host: 'evil.example', 'Content-Type': 'application/json', Accept: ACCEPT },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }));
  });
}

async function run() {
  let init;
  try {
    const { response, message } = await rpc('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'e2e-mcp', version: '1.0.0' },
    });
    init = resultOf(message);
    log(response.ok && init?.protocolVersion === '2025-11-25', 'initialize echoes protocolVersion');
  } catch (error) { log(false, 'initialize', error.message); }

  try {
    const response = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    log(response.status === 202, 'notifications/initialized returns 202', `status=${response.status}`);
    await response.arrayBuffer();
  } catch (error) { log(false, 'notifications/initialized', error.message); }

  let tools = [];
  try {
    const { response, message } = await rpc('tools/list');
    tools = resultOf(message)?.tools ?? [];
    const names = ['start_export', 'get_job_status', 'cancel_job', 'open_job_stream', 'send_chat_message', 'get_telemetry_summary'];
    const start = tools.find((tool) => tool.name === 'start_export');
    const stream = tools.find((tool) => tool.name === 'open_job_stream');
    log(response.ok && names.every((name) => tools.some((tool) => tool.name === name)), 'tools/list has six MCP tools');
    log(!!start?._meta?.ui?.resourceUri, 'start_export advertises its ui resource');
    log(stream?._meta?.ui?.visibility?.includes('app'), 'open_job_stream is app-only');
  } catch (error) { log(false, 'tools/list', error.message); }

  let viewUri = 'ui://realtime-demo/job-monitor.html';
  try {
    const { response, message } = await rpc('resources/list');
    const resources = resultOf(message)?.resources ?? [];
    log(response.ok && resources.some((resource) => resource.uri === viewUri), 'resources/list includes the MCP App view');
  } catch (error) { log(false, 'resources/list', error.message); }

  try {
    const { response, message } = await rpc('resources/read', { uri: viewUri });
    const content = resultOf(message)?.contents?.[0];
    const meta = content?._meta?.ui;
    const html = content?.text ?? '';
    log(response.ok && content?.mimeType === 'text/html;profile=mcp-app', 'resources/read returns MCP App MIME type');
    log(html.length > 10_000 && html.includes('ui/initialize'), 'MCP App HTML includes app protocol and exceeds 10 KB', `bytes=${html.length}`);
    log(meta?.csp?.connectDomains?.includes(BASE) && meta?.prefersBorder === true, 'MCP App CSP and border metadata are correct');
  } catch (error) { log(false, 'resources/read MCP App', error.message); }

  try {
    const { response, message } = await rpc('resources/read', { uri: 'realtime://technologies' });
    const content = resultOf(message)?.contents?.[0];
    log(response.ok && content?.text?.includes('WebSockets'), 'resources/read returns realtime technology catalogue');
  } catch (error) { log(false, 'resources/read technologies', error.message); }

  try {
    const { response, message } = await rpc('prompts/get', {
      name: 'choose_realtime_technology',
      arguments: {},
    });
    const prompt = resultOf(message);
    log(response.ok && prompt?.messages?.length > 0, 'prompts/get returns choose_realtime_technology');
  } catch (error) { log(false, 'prompts/get', error.message); }

  let jobId;
  try {
    const result = await callTool('start_export', { dataset: 'orders', rows: 1000, durationSeconds: 5 });
    const text = result?.content?.find((item) => item.type === 'text')?.text ?? '';
    jobId = structured(result).jobId ?? text.match(/job_[0-9a-f]{12}/)?.[0];
    log(!result?.isError && /job_[0-9a-f]{12}/.test(text) && /^job_[0-9a-f]{12}$/.test(jobId ?? ''), 'start_export returns job id in text and structuredContent', jobId);
  } catch (error) { log(false, 'start_export', error.message); }

  if (jobId) {
    try {
      const opened = await callTool('open_job_stream', { jobId });
      const streamUrl = structured(opened).url;
      const url = new URL(streamUrl);
      const ticket = url.searchParams.get('ticket');
      const controller = new AbortController();
      const response = await fetch(streamUrl, { signal: controller.signal });
      log(response.ok && response.headers.get('content-type')?.includes('text/event-stream'), 'open_job_stream returns a ticketed SSE URL');
      const firstEvents = await readSse(response, controller, true);
      const cursor = firstEvents.at(-1)?.id;
      log(firstEvents.every((event) => Number.isInteger(event.id)) && firstEvents.some((event) => event.type === 'progress'), 'SSE events carry ids and include progress');

      const reconnectUrl = new URL(streamUrl);
      reconnectUrl.searchParams.set('lastEventId', String(cursor ?? 0));
      const reconnectController = new AbortController();
      const reconnect = await fetch(reconnectUrl, { signal: reconnectController.signal });
      const laterEvents = await readSse(reconnect, reconnectController);
      log(laterEvents.length > 0 && laterEvents.every((event) => event.id > (cursor ?? 0)), 'SSE reconnect replays only newer events');
      log(['completed', 'cancelled', 'failed'].includes(laterEvents.at(-1)?.type), 'SSE stream reaches a terminal event', laterEvents.at(-1)?.type);
      log(!!ticket && url.pathname.endsWith(`/api/jobs/${jobId}/events`), 'SSE URL is scoped to the expected job');
    } catch (error) { log(false, 'SSE job stream', error.message); }
  }

  let cancelId;
  try {
    const started = await callTool('start_export', { dataset: 'orders', rows: 1000, durationSeconds: 60 });
    cancelId = structured(started).jobId;
    const first = await callTool('cancel_job', { jobId: cancelId });
    const second = await callTool('cancel_job', { jobId: cancelId });
    const status = await callTool('get_job_status', { jobId: cancelId });
    log(structured(first).status === 'cancelled', 'cancel_job cancels a running job');
    log(!second?.isError && structured(second).status === 'cancelled', 'cancel_job repeat is a harmless no-op');
    log(structured(status).status === 'cancelled', 'get_job_status reports cancelled');
  } catch (error) { log(false, 'cancel_job flow', error.message); }

  for (const [label, args] of [
    ['malformed job id', { jobId: 'bad' }],
    ['unknown job id', { jobId: 'job_000000000000' }],
  ]) {
    try {
      const result = await callTool('get_job_status', args);
      log(result?.isError === true, `get_job_status rejects ${label}`);
    } catch (error) { log(false, `get_job_status ${label}`, error.message); }
  }

  for (const [label, args] of [
    ['rows 0', { dataset: 'orders', rows: 0, durationSeconds: 5 }],
    ['durationSeconds 3', { dataset: 'orders', rows: 10, durationSeconds: 3 }],
  ]) {
    try {
      const result = await callTool('start_export', args);
      log(result?.isError === true, `start_export rejects ${label}`);
    } catch (error) { log(false, `start_export ${label}`, error.message); }
  }

  try {
    log((await requestWithBadHost()) === 403, 'bad Host is rejected with 403');
  } catch (error) { log(false, 'bad Host security check', error.message); }

  try {
    const response = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/list' }, { Origin: 'http://evil.example' });
    log(response.status === 403, 'untrusted Origin is rejected with 403', `status=${response.status}`);
  } catch (error) { log(false, 'Origin security check', error.message); }

  try {
    const allowed = await rpc('tools/list', undefined, { Origin: 'http://localhost:5173' });
    log(allowed.response.ok && !allowed.message?.error, 'localhost:5173 Origin is accepted');
  } catch (error) { log(false, 'allowed Origin', error.message); }

  if (jobId) {
    const endpoint = `${BASE}/api/jobs/${jobId}/events`;
    for (const [label, ticket] of [['no ticket', null], ['garbage ticket', 'not-a-ticket']]) {
      try {
        const url = ticket ? `${endpoint}?ticket=${encodeURIComponent(ticket)}` : endpoint;
        const response = await fetch(url);
        log(response.status === 401, `SSE rejects ${label}`, `status=${response.status}`);
      } catch (error) { log(false, `SSE ${label}`, error.message); }
    }

    try {
      const other = await callTool('start_export', { dataset: 'orders', rows: 10, durationSeconds: 60 });
      const otherStream = await callTool('open_job_stream', { jobId: structured(other).jobId });
      const url = new URL(structured(otherStream).url);
      url.pathname = `/api/jobs/${jobId}/events`;
      const response = await fetch(url);
      log(response.status === 401, 'SSE rejects ticket issued for another job', `status=${response.status}`);
    } catch (error) { log(false, 'cross-job ticket security check', error.message); }
  }

  try {
    const result = await callTool('send_chat_message', { text: 'Hello from MCP e2e' });
    log(!result?.isError && structured(result).posted === true, 'send_chat_message posts to chat');
  } catch (error) { log(false, 'send_chat_message', error.message); }

  try {
    const result = await callTool('get_telemetry_summary');
    const text = result?.content?.find((item) => item.type === 'text')?.text ?? '';
    const data = JSON.stringify(structured(result));
    log(`${text} ${data}`.includes('MCP'), 'get_telemetry_summary mentions MCP');
  } catch (error) { log(false, 'get_telemetry_summary', error.message); }

  try {
    const { response, message } = await rpc('tools/list');
    log(response.ok && !!message?.result?.tools?.length, 'stateless tools/list works without initialize');
  } catch (error) { log(false, 'stateless request without initialize', error.message); }

  console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
}

run().catch((error) => { console.error('FATAL', error); process.exit(1); });
