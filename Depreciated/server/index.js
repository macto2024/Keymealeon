import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime } from './runtime.js';
import { EditorBridge } from './editor.js';
import { VoiceManager } from './voice.js';
import { AgentObserver } from './agents.js';

const base = fileURLToPath(new URL('../', import.meta.url));
const executable = name => process.env.PATH?.split(path.delimiter).map(folder => path.join(folder, name)).find(existsSync) || null;
const config = JSON.parse(await readFile(process.env.SIX_CONFIG || path.join(base, 'six.config.json'), 'utf8'));
if (config.root) config.root = path.resolve(base, config.root);
if (config.command != null && (!Array.isArray(config.command) || !config.command.length || !config.command.every(value => typeof value === 'string'))) throw new Error('Configure command as an executable/argument array.');
const runtime = new Runtime(config);
const editor = new EditorBridge(runtime);
runtime.editor = editor;
new AgentObserver(runtime);
const voice = new VoiceManager(runtime, { ffmpeg: process.env.SIX_FFMPEG || executable('ffmpeg'), whisper: process.env.SIX_WHISPER || executable('whisper'), model: config.voiceModel || 'base', language: config.voiceLanguage || 'en' });
await runtime.start();
const clients = new Set();
runtime.on('snapshot', snapshot => { for (const client of clients) client.write(`data: ${JSON.stringify(snapshot)}\n\n`); });
const port = Number(process.env.PORT || 5173);
const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
// The demo storefront runs on its own origin, so one endpoint has to answer cross-origin.
// It stays loopback-bound, is allowlisted by exact origin, size-capped, and can only ever set
// display text -- it dispatches nothing. Everything else keeps the strict same-origin gate.
const browserOrigins = new Set(config.browserOrigins || [`http://127.0.0.1:${port + 1}`, `http://localhost:${port + 1}`]);
const loopbackHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

async function browserReport(req, res, json) {
  const origin = req.headers.origin;
  if (!loopbackHosts.has(req.headers.host) || !origin || !browserOrigins.has(origin)) return json(403, { error: 'This origin may not report browser state.' });
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Max-Age': '600' }); return res.end(); }
  if (req.method !== 'POST') return json(405, { error: 'POST only.' });
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 8192) return json(413, { error: 'Report too large.' }); }
  return json(200, runtime.setBrowser(JSON.parse(body || '{}')));
}
// This repository publishes the backend. A display client (the six-key surface the native monitor
// loads into its WebView) is served from these paths when its files are present next to the server;
// `live.js` ships here so a client can render the same layer the backend resolved.
const assets = { '/': ['index.html', 'text/html'], '/style.css': ['style.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'], '/live.js': ['live.js', 'text/javascript'] };
const server = http.createServer(async (req, res) => {
  const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/browser/report') return browserReport(req, res, json);
    if (!origins.has(`http://${req.headers.host}`) || (req.headers.origin && !origins.has(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: 'Local same-origin clients only.' });
    if (req.method === 'GET' && url.pathname === '/api/context') return json(200, { context: runtime.context, keys: runtime.layout(), token: runtime.token });
    if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { ok: true, project: config.root });
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ context: runtime.context, keys: runtime.layout(), token: runtime.token, message: 'Live backend connected' })}\n\n`);
      clients.add(res); const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
      req.on('close', () => { clients.delete(res); clearInterval(heartbeat); }); return;
    }
    if (req.method === 'POST' && ['/api/action', '/api/key', '/api/system/context', '/api/surface/focus', '/api/editor/context', '/api/editor/ack'].includes(url.pathname)) {
      if (req.headers['x-six-token'] !== runtime.token || !req.headers['content-type']?.startsWith('application/json')) return json(403, { error: 'Invalid local session.' });
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 65536) return json(413, { error: 'Request too large.' }); }
      const payload = JSON.parse(body);
      if (url.pathname === '/api/editor/context') return json(200, await editor.update(payload));
      if (url.pathname === '/api/editor/ack') return json(200, editor.ack(payload));
      if (url.pathname === '/api/system/context') return json(200, runtime.setForeground(payload));
      if (url.pathname === '/api/surface/focus') return json(200, runtime.setPopupFocus(payload));
      if (url.pathname === '/api/key') return json(200, await runtime.press(payload.slot, payload.revision));
      const { id, revision } = payload;
      return json(200, await runtime.action(id, revision, payload));
    }
    if (req.method === 'GET' && assets[url.pathname]) {
      const [file, type] = assets[url.pathname];
      const full = path.join(base, file);
      if (!existsSync(full)) return json(404, { error: `No display client installed: ${file} is not present. The API is still available.` });
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(await readFile(full)); return;
    }
    json(404, { error: 'Not found' });
  } catch (error) { if (!res.headersSent) json(error.status || 400, { error: error.message }); else res.end(); }
});
server.listen(port, '127.0.0.1', () => console.log(`SIX keyboard backend: http://127.0.0.1:${port}\nProject: ${config.root || 'waiting for VS Code'}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { voice.close(); editor.close(); runtime.close(); for (const client of clients) client.end(); server.close(() => process.exit()); });
