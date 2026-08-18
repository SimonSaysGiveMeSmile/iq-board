import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { runTestSession } from './session.js';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const RUNS_DIR = path.join(DATA_DIR, 'runs');
const INDEX_FILE = path.join(DATA_DIR, 'runs.json');
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_RUNS || 2);

export class Arena {
  constructor() {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    this.runs = new Map();
    this.listeners = new Set();
    this.active = 0;
    this.queue = [];
    this.browser = null;
    this.loadIndex();
  }

  loadIndex() {
    try {
      for (const run of JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'))) {
        // Anything mid-flight when the process died is a dead run.
        if (run.status === 'running' || run.status === 'queued') {
          run.status = 'error';
          run.error = 'interrupted by server restart';
        }
        this.runs.set(run.id, run);
      }
    } catch { /* first boot */ }
  }

  saveIndex() {
    fs.writeFileSync(INDEX_FILE, JSON.stringify([...this.runs.values()], null, 2));
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  broadcast(runId, event) {
    for (const fn of this.listeners) {
      try { fn({ runId, event }); } catch { /* listener died */ }
    }
  }

  listRuns() {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  getRun(id) { return this.runs.get(id) || null; }

  getEvents(id) {
    try {
      return fs.readFileSync(path.join(RUNS_DIR, id, 'events.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  }

  shotsDir(id) { return path.join(RUNS_DIR, id); }

  createRun({ provider, model, label, effort, apiKey }) {
    const id = crypto.randomBytes(6).toString('hex');
    const run = {
      id,
      provider,
      model,
      label: label || `${provider}/${model}`,
      effort: effort || undefined,
      status: 'queued',
      createdAt: Date.now(),
      question: 0,
      totalQuestions: 35,
      secondsRemaining: null,
      score: null,
      error: null,
    };
    this.runs.set(id, run);
    // API key is kept off the persisted record — memory only, for this run.
    this.queue.push({ id, apiKey });
    this.saveIndex();
    this.emitRunEvent(run, 'queued', { position: this.queue.length });
    this.pump();
    return run;
  }

  emitRunEvent(run, type, payload = {}) {
    const event = { type, t: Date.now(), ...payload };
    fs.mkdirSync(this.shotsDir(run.id), { recursive: true });
    fs.appendFileSync(path.join(this.shotsDir(run.id), 'events.jsonl'), `${JSON.stringify(event)}\n`);
    this.broadcast(run.id, { ...event, run: publicRun(run) });
  }

  async getBrowser() {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    }
    return this.browser;
  }

  pump() {
    while (this.active < MAX_CONCURRENT && this.queue.length) {
      const job = this.queue.shift();
      this.active += 1;
      this.execute(job).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  async execute({ id, apiKey }) {
    const run = this.runs.get(id);
    run.status = 'running';
    this.saveIndex();
    this.emitRunEvent(run, 'started', {});
    try {
      const browser = await this.getBrowser();
      const result = await runTestSession({
        browser,
        run: { ...run, apiKey },
        shotsDir: this.shotsDir(id),
        emit: (type, payload) => {
          if (payload.question) run.question = payload.question;
          if (payload.secondsRemaining !== undefined) run.secondsRemaining = payload.secondsRemaining;
          // Persist the latest visuals so desks re-render fully after a reload/restart.
          if (payload.screenshot) run.lastShot = payload.screenshot;
          if (payload.rationale) run.lastRationale = payload.rationale;
          this.emitRunEvent(run, type, payload);
        },
      });
      run.score = result.score;
      run.answers = result.answers;
      run.status = 'finished';
      run.finishedAt = Date.now();
      this.emitRunEvent(run, 'finished', { score: result.score });
    } catch (err) {
      run.status = 'error';
      run.error = String(err?.message || err).slice(0, 500);
      this.emitRunEvent(run, 'run_error', { error: run.error });
    }
    this.saveIndex();
  }
}

export function publicRun(run) {
  const { answers, ...rest } = run;
  return rest;
}
