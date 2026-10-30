// HR Hub: Talent Copilot backend.
// Serves the chat UI, relays chat messages to the EKB (Automation Anywhere
// Enterprise Knowledge) agent, and proxies resume PDFs from CATS.
// No dependencies: needs Node 18+ (built-in fetch, FormData, streams).

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
await loadDotEnv();
const cfg = {
  port: Number(process.env.PORT || 3000),
  ekbBase: ensureSlash(process.env.EKB_BASE_URL || 'https://api.getodin.ai/'),
  ekbKey: process.env.EKB_API_KEY || '',
  ekbSecret: process.env.EKB_API_SECRET || '',
  ekbProject: process.env.EKB_PROJECT_ID || '',
  ekbAgent: process.env.EKB_AGENT_ID || '',
  catsKey: process.env.CATS_API_KEY || '',
  appUser: process.env.APP_USER || 'hr',
  appPassword: process.env.APP_PASSWORD || '',
  mock: process.env.MOCK === '1',
};

const missing = [];
if (!cfg.mock) {
  for (const [k, v] of Object.entries({
    EKB_API_KEY: cfg.ekbKey, EKB_API_SECRET: cfg.ekbSecret, EKB_PROJECT_ID: cfg.ekbProject,
    EKB_AGENT_ID: cfg.ekbAgent, CATS_API_KEY: cfg.catsKey,
  })) if (!v) missing.push(k);
}
if (missing.length) console.warn(`[config] Missing: ${missing.join(', ')}. Set them in .env or the host's environment.`);
if (!cfg.appPassword) console.warn('[config] APP_PASSWORD is not set: the app is open to anyone who can reach it.');

const CATS = 'https://api.catsone.com/v3';

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    if (!authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="HR Hub"', 'Content-Type': 'text/plain' });
      return res.end('Sign in required');
    }
    const url = new URL(req.url, 'http://x');

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readFile(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true, mock: cfg.mock });
    if (req.method === 'POST' && url.pathname === '/api/chat') return handleChat(req, res);

    const m = url.pathname.match(/^\/api\/resume\/(\d{1,15})$/);
    if (req.method === 'GET' && m) return handleResume(res, m[1], url.searchParams.get('download') === '1');

    json(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'Server error' });
    else res.end();
  }
});
server.listen(cfg.port, () => console.log(`HR Hub running on http://localhost:${cfg.port}${cfg.mock ? ' (MOCK mode)' : ''}`));

// ---------- chat ----------
// Client sends {message, chatId?}. We answer with Server-Sent Events:
//   event: chat   data: {"chatId": "..."}
//   event: chunk  data: {"text": "..."}
//   event: done   data: {}
//   event: error  data: {"message": "..."}
async function handleChat(req, res) {
  const body = await readJson(req);
  const message = String(body.message || '').trim().slice(0, 4000);
  if (!message) return json(res, 400, { error: 'Message is empty' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  if (cfg.mock) return mockChat(message, send, res);

  try {
    let chatId = typeof body.chatId === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(body.chatId) ? body.chatId : '';
    if (!chatId) {
      const created = await ekb('chat/create', { project_id: cfg.ekbProject, name: message.slice(0, 60) });
      chatId = created.chat_id;
    }
    send('chat', { chatId });

    const form = new FormData();
    form.append('message', message);
    form.append('project_id', cfg.ekbProject);
    form.append('chat_id', chatId);
    form.append('agent_type', 'chat_agent');
    form.append('agent_id', cfg.ekbAgent);
    form.append('use_knowledgebase', 'false');
    form.append('is_test', 'false');
    form.append('google_search', 'false');
    form.append('format_instructions', 'normal');
    form.append('ignore_chat_history', 'false');

    const upstream = await fetch(`${cfg.ekbBase}v3/chat/message`, {
      method: 'POST',
      headers: { 'X-API-KEY': cfg.ekbKey, 'X-API-SECRET': cfg.ekbSecret },
      body: form,
    });
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      console.error('[ekb] message failed', upstream.status, detail.slice(0, 500));
      send('error', { message: `The assistant is unavailable (EKB ${upstream.status}).` });
      return res.end();
    }

    // EKB streams tagged segments: <msg_chunk>text<mi>{json}<msmro>...
    // We forward only the text inside <msg_chunk> segments.
    const parser = new EkbStreamParser();
    const decoder = new TextDecoder();
    for await (const part of upstream.body) {
      const delta = parser.push(decoder.decode(part, { stream: true }));
      if (delta) send('chunk', { text: delta });
    }
    const tail = parser.finish();
    if (tail) send('chunk', { text: tail });
    send('done', {});
  } catch (err) {
    console.error('[chat]', err);
    send('error', { message: 'Something went wrong talking to the assistant.' });
  }
  res.end();
}

class EkbStreamParser {
  static TAGS = ['msg_chunk', 'msmro', 'msg_object', 'mi', 'ui_form', 'ma', 'doc', 'sql'];
  constructor() { this.raw = ''; this.sent = 0; }
  push(chunk) { this.raw += chunk; return this.#delta(false); }
  finish() { return this.#delta(true); }
  #delta(final) {
    let raw = this.raw;
    if (!final) {
      // Hold back a trailing "<..." that may be the start of a tag split across reads.
      const lt = raw.lastIndexOf('<');
      if (lt !== -1 && raw.length - lt <= 12 && !raw.slice(lt).includes('>')) raw = raw.slice(0, lt);
    }
    const text = EkbStreamParser.extract(raw);
    const delta = text.slice(this.sent);
    this.sent = text.length;
    return delta;
  }
  static extract(raw) {
    const re = new RegExp(`<(${EkbStreamParser.TAGS.join('|')})>`, 'g');
    const marks = [];
    let m;
    while ((m = re.exec(raw))) marks.push({ tag: m[1], start: m.index, end: re.lastIndex });
    let out = '';
    for (let i = 0; i < marks.length; i++) {
      if (marks[i].tag !== 'msg_chunk') continue;
      const stop = i + 1 < marks.length ? marks[i + 1].start : raw.length;
      out += raw.slice(marks[i].end, stop);
    }
    return out;
  }
}

async function ekb(endpoint, payload) {
  const r = await fetch(`${cfg.ekbBase}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': cfg.ekbKey, 'X-API-SECRET': cfg.ekbSecret },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`EKB ${endpoint} ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// ---------- resumes ----------
// Finds the candidate's most recent resume attachment in CATS and streams the file.
async function handleResume(res, candidateId, download) {
  if (cfg.mock) return json(res, 501, { error: 'Resumes are not available in MOCK mode.' });
  const auth = { Authorization: `Token ${cfg.catsKey}` };

  const list = await fetch(`${CATS}/candidates/${candidateId}/attachments?per_page=100`, { headers: auth });
  if (list.status === 404) return json(res, 404, { error: 'Candidate not found in CATS.' });
  if (!list.ok) return json(res, 502, { error: `CATS returned ${list.status}.` });
  const data = await list.json();
  const atts = data?._embedded?.attachments || data?._embedded?.activities || [];
  const resumes = atts.filter((a) => a.is_resume);
  const pick = (resumes.length ? resumes : atts).sort((a, b) => b.id - a.id)[0];
  if (!pick) return json(res, 404, { error: 'This candidate has no resume on file.' });

  const file = await fetch(`${CATS}/attachments/${pick.id}/download`, { headers: auth, redirect: 'follow' });
  if (!file.ok || !file.body) return json(res, 502, { error: `Could not download the resume (CATS ${file.status}).` });

  const name = String(pick.filename || `resume-${candidateId}.pdf`).replace(/[^\w.\- ]+/g, '_');
  const type = file.headers.get('content-type') || guessType(name);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${name}"`,
    'Cache-Control': 'private, no-store',
  });
  for await (const part of file.body) res.write(part);
  res.end();
}

function guessType(name) {
  const ext = name.toLowerCase().split('.').pop();
  return { pdf: 'application/pdf', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain; charset=utf-8', rtf: 'application/rtf' }[ext] || 'application/octet-stream';
}

// ---------- mock mode (local UI testing without keys) ----------
async function mockChat(message, send, res) {
  send('chat', { chatId: 'mock_chat_1' });
  const isSearch = /develop|engineer|need|find|hire|candidate|react|java|python|qa|devops/i.test(message);
  const reply = isSearch
    ? 'I’m searching CATS now.[[SEARCH]]{"query": "(React OR "React.js" OR Next.js) AND (Goa OR Pune)", "total": 1106}[[/SEARCH]] Here are the 3 strongest fits, most recently updated first. [[CANDIDATES]] [{"id": 1001, "name": "Sample Candidate One", "title": "Senior Frontend Engineer", "city": "Panaji", "updated": "2026-07-06", "why": "React and Next.js in key skills, based in Goa."}, {"id": 1002, "name": "Sample Candidate Two", "title": null, "city": "Ponda", "updated": "2026-01-08", "why": "Resume matched React; title and skills are not on file."}, {"id": 1003, "name": "Sample Candidate Three", "title": "Full Stack Developer", "city": "Pune", "updated": "2023-03-14", "why": "React with Node.js, based in Pune."}] [[/CANDIDATES]] The third profile was last updated over 2 years ago, so check it is still current.'
    : 'This is MOCK mode, so I can only show sample replies. Set the EKB and CATS keys in .env to talk to the real Talent Copilot.';
  for (let i = 0; i < reply.length; i += 18) {
    send('chunk', { text: reply.slice(i, i + 18) });
    await new Promise((r) => setTimeout(r, 25));
  }
  send('done', {});
  res.end();
}

// ---------- helpers ----------
function authorized(req) {
  if (!cfg.appPassword) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return u === cfg.appUser && p.join(':') === cfg.appPassword;
}
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
async function readJson(req) {
  let size = 0; const parts = [];
  for await (const c of req) { size += c.length; if (size > 64_000) throw new Error('Body too large'); parts.push(c); }
  try { return JSON.parse(Buffer.concat(parts).toString() || '{}'); } catch { return {}; }
}
function ensureSlash(u) { return u.endsWith('/') ? u : `${u}/`; }
async function loadDotEnv() {
  try {
    const txt = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env file: rely on the environment */ }
}
