// HR Hub: Talent Copilot backend.
// Serves the chat UI, relays chat messages to the EKB (Automation Anywhere
// Enterprise Knowledge) agent, and proxies resume PDFs from CATS.
// No dependencies: needs Node 18+ (built-in fetch, FormData, streams).

import http from 'node:http';
import crypto from 'node:crypto';
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
    if (!cfg.mock && !cfg.appPassword && !isLocal(req) && new URL(req.url, 'http://x').pathname !== '/healthz') {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('HR Hub is locked: set APP_PASSWORD in the environment to open it.');
    }
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true, mock: cfg.mock });
    if (url.pathname === '/login') return handleLogin(req, res);
    if (req.method === 'GET' && url.pathname === '/tools/search') return handleToolSearch(req, res, url);
    if (req.method === 'POST' && url.pathname === '/logout') {
      res.writeHead(303, { 'Set-Cookie': sessionCookie(req, '', 0), Location: '/login' });
      return res.end();
    }
    if (!authorized(req)) {
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        res.writeHead(303, { Location: '/login' });
        return res.end();
      }
      return json(res, 401, { error: 'Your session has expired. Please sign in again.' });
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readFile(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
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

// ---------- tool endpoint for the EKB agent ----------
// The EKB API tool calls this instead of CATS directly. It forwards the search to CATS
// and returns only the fields the agent needs, so results are not truncated in EKB.
// Auth: the same "Authorization: Token <CATS key>" header the tool already sends.
async function handleToolSearch(req, res, url) {
  if (!cfg.catsKey || !safeEqual(req.headers.authorization || '', `Token ${cfg.catsKey}`)) {
    return json(res, 401, { error: 'Unauthorized' });
  }
  const query = String(url.searchParams.get('query') || '').slice(0, 1000);
  if (!query.trim()) return json(res, 400, { error: 'query is required' });
  const page = clampInt(url.searchParams.get('page'), 1, 1, 1000);
  const perPage = clampInt(url.searchParams.get('per_page'), 25, 1, 100);

  // Optional location filter on the candidate's city field ("Goa, Pune" = either). "any" or empty = no filter.
  const cities = String(url.searchParams.get('city') || '')
    .split(',').map((s) => s.trim()).filter((s) => s && !/^(any|none|null|all)$/i.test(s)).slice(0, 10);

  const qs = new URLSearchParams({ query, page: String(page), per_page: String(perPage) });
  const headers = { Authorization: `Token ${cfg.catsKey}` };
  let r;
  if (cities.length) {
    // Goa is a state, not a city, so each name is matched against city OR state.
    const filter = { or: cities.flatMap((c) => [
      { field: 'address.city', filter: 'contains', value: c },
      { field: 'address.state', filter: 'contains', value: c },
    ]) };
    r = await fetch(`${CATS}/candidates/search?${qs}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(filter),
    });
  } else {
    r = await fetch(`${CATS}/candidates/search?${qs}`, { headers });
  }
  if (!r.ok) return json(res, 502, { error: `CATS returned ${r.status}` });
  const data = await r.json();
  const list = data?._embedded?.candidates || [];
  json(res, 200, {
    query, city_filter: cities.length ? cities : null, page, per_page: perPage,
    total: data.total ?? null,
    total_pages: data.total != null ? Math.ceil(data.total / perPage) : null,
    candidates: list.map((c) => ({
      id: c.id,
      name: [c.first_name, c.last_name].filter(Boolean).join(' '),
      title: c.title || null,
      current_employer: c.current_employer || null,
      key_skills: c.key_skills ? String(c.key_skills).slice(0, 300) : null,
      city: c.address?.city || null,
      state: c.address?.state || null,
      willing_to_relocate: c.is_willing_to_relocate ?? null,
      updated: c.date_modified ? String(c.date_modified).slice(0, 10) : null,
    })),
  });
}
function clampInt(v, dflt, min, max) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
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
  const upstreamType = (file.headers.get('content-type') || '').split(';')[0].trim();
  const type = !upstreamType || upstreamType === 'application/octet-stream' ? guessType(name) : upstreamType;
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

// ---------- sign-in (signed session cookie) ----------
const SESSION_HOURS = 12;
const COOKIE = 'hrhub_session';
const attempts = new Map(); // ip -> {n, until}

function sign(value) {
  return crypto.createHmac('sha256', `hrhub:${cfg.appUser}:${cfg.appPassword}`).update(value).digest('base64url');
}
function sessionCookie(req, value, maxAge) {
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
function authorized(req) {
  if (!cfg.appPassword) return true;
  const raw = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return false;
  const [exp, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, sign(exp));
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
async function handleLogin(req, res) {
  if (!cfg.appPassword) { res.writeHead(303, { Location: '/' }); return res.end(); }
  if (req.method === 'GET') return sendLoginPage(res, '');
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const rec = attempts.get(ip);
  if (rec && rec.n >= 8 && rec.until > Date.now()) return sendLoginPage(res, 'Too many attempts. Try again in 15 minutes.', 429);

  let size = 0; const parts = [];
  for await (const c of req) { size += c.length; if (size > 4000) break; parts.push(c); }
  const form = new URLSearchParams(Buffer.concat(parts).toString());
  const ok = safeEqual(form.get('user') || '', cfg.appUser) & safeEqual(form.get('password') || '', cfg.appPassword);
  if (!ok) {
    const r = rec && rec.until > Date.now() ? rec : { n: 0, until: Date.now() + 15 * 60_000 };
    r.n += 1; attempts.set(ip, r);
    await new Promise((r2) => setTimeout(r2, 600));
    return sendLoginPage(res, 'Wrong username or password.', 401);
  }
  attempts.delete(ip);
  const exp = String(Date.now() + SESSION_HOURS * 3600_000);
  res.writeHead(303, { 'Set-Cookie': sessionCookie(req, `${exp}.${sign(exp)}`, SESSION_HOURS * 3600), Location: '/' });
  res.end();
}
function sendLoginPage(res, error, status = 200) {
  const err = error ? `<p class="err" role="alert">${error.replace(/[<>&"]/g, '')}</p>` : '';
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in · HR Hub</title>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;color:#0F172A;font-family:Inter,system-ui,sans-serif;padding:24px}
form{width:100%;max-width:380px;display:flex;flex-direction:column;gap:16px}.brand{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.logo{width:36px;height:36px;border-radius:10px;background:#0F172A;color:#fff;display:grid;place-items:center;font:800 14px Manrope,sans-serif}
h1{margin:0;font:800 26px Manrope,sans-serif}label{display:flex;flex-direction:column;gap:6px;font-size:14px;font-weight:600;color:#334155}
input{height:48px;padding:0 14px;border:1px solid #CBD5E1;border-radius:12px;font:inherit;font-size:16px;font-weight:400;color:#0F172A}input:focus{outline:2px solid #0F766E;outline-offset:1px;border-color:#0F766E}
button{height:48px;border:0;border-radius:12px;background:#0F766E;color:#fff;font:inherit;font-weight:600;font-size:16px;cursor:pointer}.err{margin:0;color:#9F1239;font-size:14px}</style></head>
<body><form method="post" action="/login"><div class="brand"><div class="logo" aria-hidden="true">HR</div><h1>HR Hub</h1></div>${err}
<label>Username<input name="user" autocomplete="username" required autofocus value="${cfg.appUser === 'hr' ? 'hr' : ''}"></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">Sign in</button></form></body></html>`);
}

// ---------- helpers ----------
function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return !req.headers['x-forwarded-for'] && (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1');
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
