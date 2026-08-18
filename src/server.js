import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { Arena, publicRun } from './arena.js';
import { providers, providerMeta } from './providers/index.js';

const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
// Human reference entry shown on the leaderboard.
const HUMAN_BASELINE = { label: process.env.HUMAN_LABEL || 'Simon (human, manual run)', iq: Number(process.env.HUMAN_IQ || 138) };

const IP_DAILY_LIMIT = Number(process.env.IP_DAILY_LIMIT || 3);

const arena = new Arena();
const app = express();
app.set('trust proxy', true); // Railway proxy: req.ip = client IP from X-Forwarded-For
app.use(express.json({ limit: '256kb' }));

app.use(express.static(path.resolve('public')));
app.use('/shots', express.static(path.resolve(process.env.DATA_DIR || 'data', 'runs'), { maxAge: '1h' }));

app.get('/api/meta', (_req, res) => {
  res.json({
    providers: providerMeta(),
    humanBaseline: HUMAN_BASELINE,
    adminRequired: Boolean(ADMIN_TOKEN),
    test: { name: 'Mensa Norway IQ Test (linked by Mensa Sweden)', url: 'https://test.mensa.no/', questions: 35, minutes: 25 },
  });
});

// Runs to hide from the public feed (e.g. voided attempts), comma-separated ids.
const HIDDEN = new Set((process.env.HIDE_RUNS || '').split(',').filter(Boolean));

app.get('/api/runs', (_req, res) => {
  res.json(arena.listRuns().filter((r) => !HIDDEN.has(r.id)).map(publicRun));
});

app.get('/api/runs/:id', (req, res) => {
  const run = arena.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  res.json({ run: publicRun(run), events: arena.getEvents(run.id) });
});

app.post('/api/runs', (req, res) => {
  if (ADMIN_TOKEN && req.get('x-admin-token') !== ADMIN_TOKEN) {
    return res.status(403).json({ error: 'invalid admin token' });
  }
  const { provider, model, label, effort, apiKey } = req.body || {};
  const p = providers[provider];
  if (!p) return res.status(400).json({ error: `unknown provider "${provider}"` });
  const resolvedModel = (model || '').trim() || p.defaultModel;
  if (p.envKey && !apiKey && !process.env[p.envKey] && !(p.id === 'google' && process.env.GEMINI_API_KEY)) {
    return res.status(400).json({ error: `no API key: set ${p.envKey} on the server or supply one in the launcher` });
  }
  // Visitors are distinguished by IP; each IP gets a daily allowance.
  const ip = req.ip || 'unknown';
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const used = arena.listRuns().filter((r) => r.ip === ip && r.createdAt > dayAgo).length;
  if (used >= IP_DAILY_LIMIT) {
    return res.status(429).json({ error: `daily allowance reached (${IP_DAILY_LIMIT} runs per visitor per day)` });
  }
  const run = arena.createRun({ provider, model: resolvedModel, label, effort, apiKey, ip });
  res.json(publicRun(run));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'snapshot', runs: arena.listRuns().map(publicRun) }));
});

arena.onEvent(({ runId, event }) => {
  const msg = JSON.stringify({ type: 'run_event', runId, event });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
});

server.listen(PORT, () => {
  console.log(`iq-board arena listening on :${PORT}`);
  if (!ADMIN_TOKEN) console.log('warning: ADMIN_TOKEN not set — anyone can launch runs');
});
