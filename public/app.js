/* IQ BOARD — live dashboard client */

const state = {
  meta: null,
  runs: new Map(),          // id -> run
  latest: new Map(),        // id -> { screenshot, rationale, answers: Map(q -> {answer, fallback}) }
  openRun: null,
};

const $ = (id) => document.getElementById(id);
const fmtClock = (s) => (s == null ? '—:——' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

/* ── boot ── */
async function boot() {
  state.meta = await fetch('/api/meta').then((r) => r.json());
  const sel = $('f-provider');
  sel.innerHTML = state.meta.providers
    .map((p) => `<option value="${p.id}">${p.label}${p.hasEnvKey ? '' : ' — needs key'}</option>`)
    .join('');
  sel.addEventListener('change', () => {
    const p = state.meta.providers.find((x) => x.id === sel.value);
    $('f-model').placeholder = p ? p.defaultModel : '';
    $('effort-field').style.display = sel.value === 'anthropic' ? '' : 'none';
  });
  sel.dispatchEvent(new Event('change'));
  if (state.meta.adminRequired) {
    // Curated mode: launches happen server-side; visitors just watch.
    $('launch-form').style.display = 'none';
  }

  const runs = await fetch('/api/runs').then((r) => r.json());
  for (const run of runs) state.runs.set(run.id, run);
  renderAll();
  connect();
}

/* ── websocket ── */
let ws;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => setConn(true);
  ws.onclose = () => { setConn(false); setTimeout(connect, 2500); };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === 'snapshot') {
      for (const run of msg.runs) state.runs.set(run.id, run);
      renderAll();
    } else if (msg.type === 'run_event') {
      handleEvent(msg.runId, msg.event);
    }
  };
}
function setConn(ok) {
  $('conn-dot').classList.toggle('ok', ok);
  $('conn-text').textContent = ok ? 'LIVE FEED' : 'RECONNECTING';
}

function handleEvent(runId, event) {
  if (event.run) state.runs.set(runId, event.run);
  const latest = state.latest.get(runId) || { answers: new Map() };
  if (event.type === 'question_shown') { latest.screenshot = event.screenshot; latest.question = event.question; }
  if (event.type === 'answer_chosen') {
    latest.rationale = event.rationale;
    latest.answers.set(event.question, { answer: event.answer, fallback: event.fallback });
  }
  state.latest.set(runId, latest);
  feedTicker(runId, event);
  renderAll();
  if (state.openRun === runId) loadOverlay(runId);
}

/* live invigilator's ticker */
const tickerLines = [];
function feedTicker(runId, event) {
  const run = state.runs.get(runId);
  const who = (run?.label || runId).toUpperCase();
  let line = null;
  if (event.type === 'answer_chosen') line = `${who} MARKS ${event.answer} ON Q${event.question}${event.fallback ? ' (GUESS)' : ''}`;
  else if (event.type === 'test_started') line = `${who} TURNS OVER THE PAPER`;
  else if (event.type === 'score') line = event.iq != null ? `${who} SCORES IQ ${event.iq}` : `${who}: UNSCORED`;
  else if (event.type === 'run_error') line = `${who} EXPELLED — ERROR`;
  if (!line) return;
  tickerLines.unshift(line);
  tickerLines.length = Math.min(tickerLines.length, 8);
  const html = tickerLines.map((l) => `<span>${esc(l)}&nbsp;·&nbsp;</span>`).join('');
  document.getElementById('ticker').innerHTML = html + html; // doubled for seamless loop
}

/* ── rendering ── */
function renderAll() { renderDesks(); renderLedger(); }

function renderDesks() {
  const desks = $('desks');
  const runs = [...state.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  const activeFirst = runs.filter((r) => r.status === 'running' || r.status === 'queued')
    .concat(runs.filter((r) => r.status !== 'running' && r.status !== 'queued').slice(0, 8));
  $('hall-count').textContent = `${runs.filter((r) => r.status === 'running').length} SITTING / ${runs.length} TOTAL`;
  $('empty-hall').style.display = activeFirst.length ? 'none' : '';

  for (const el of desks.querySelectorAll('.desk')) {
    if (!activeFirst.find((r) => r.id === el.dataset.id)) el.remove();
  }
  activeFirst.forEach((run, i) => {
    let el = desks.querySelector(`.desk[data-id="${run.id}"]`);
    if (!el) {
      el = document.createElement('article');
      el.className = 'desk';
      el.dataset.id = run.id;
      el.addEventListener('click', () => openOverlay(run.id));
      desks.insertBefore(el, desks.children[i] || null);
    }
    el.classList.toggle('running', run.status === 'running');
    el.innerHTML = deskHTML(run);
  });
}

function deskHTML(run) {
  const latest = state.latest.get(run.id) || { answers: new Map() };
  // Fall back to server-persisted visuals (survives page reloads).
  if (!latest.screenshot && run.lastShot) latest.screenshot = run.lastShot;
  if (!latest.rationale && run.lastRationale) latest.rationale = run.lastRationale;
  const bubbles = Array.from({ length: run.totalQuestions || 35 }, (_, i) => {
    const a = latest.answers.get(i + 1);
    if (a) return `<span class="bubble ${a.fallback ? 'guess' : 'done'}" title="Q${i + 1}: ${a.answer}${a.fallback ? ' (fallback)' : ''}"></span>`;
    if (run.status === 'running' && i + 1 === run.question) return '<span class="bubble now"></span>';
    return '<span class="bubble"></span>';
  }).join('');

  const shot = latest.screenshot
    ? `<img src="/shots/${run.id}/${latest.screenshot}" alt="current question" />`
    : '<span class="noshot">AWAITING FIRST QUESTION…</span>';

  let footer = '';
  if (run.status === 'finished' && run.score) {
    footer = run.score.iq != null
      ? `<div class="desk-score"><span>MEASURED IQ</span><span class="iq">${run.score.iq}<small> ${run.score.percentile ? `· ${run.score.percentile} %ile` : ''}</small></span></div>`
      : `<div class="desk-error">no score: ${run.score.note || 'unknown'}</div>`;
  } else if (run.status === 'error') {
    footer = `<div class="desk-error">${esc(run.error || 'failed')}</div>`;
  }

  return `
    <div class="desk-head"><span>№ ${run.id}${run.by ? ` · by ${esc(run.by)}` : ''}</span><span class="status">${run.status}</span></div>
    <div class="desk-name">${esc(run.label)}</div>
    <div class="desk-model">${esc(run.provider)} / ${esc(run.model)}${run.effort ? ` · effort:${run.effort}` : ''}</div>
    <div class="desk-clock">
      <span class="time">${fmtClock(run.secondsRemaining)}</span>
      <span class="qno">Q ${run.question || '—'} / ${run.totalQuestions || 35}</span>
    </div>
    <div class="bubbles">${bubbles}</div>
    <div class="desk-shot">${shot}</div>
    <div class="desk-thought">${latest.rationale ? `“${esc(latest.rationale)}”` : '<span style="color:#999">…</span>'}</div>
    ${footer}`;
}

// Percentile on the standard IQ curve (mean 100, SD 15) when Mensa didn't supply one.
function percentileFromIq(iq) {
  const z = (iq - 100) / 15;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const dens = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const p = z >= 0 ? 1 - dens * poly : dens * poly;
  return Math.round(p * 1000) / 10;
}

function pctText(iq, sitePct) {
  if (iq == null) return '<16th %ile';
  const p = sitePct ? parseFloat(sitePct) : percentileFromIq(iq);
  return `${p}th %ile`;
}

function renderLedger() {
  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const rows = [...state.runs.values()]
    .filter((r) => r.status === 'finished' && r.score
      && (r.score.iq != null || r.score.note === 'below_measurable_range'))
    .map((r) => ({
      label: r.label,
      mark: r.score.iq != null ? String(r.score.iq) : '<85',
      pct: pctText(r.score.iq, r.score.percentile),
      // The site only measures 85-145; below-range runs sort under everything scored.
      sortVal: r.score.iq != null ? r.score.iq : 84,
      sub: `${r.provider}/${r.model}${r.effort ? ` · ${r.effort}` : ''}${r.by ? ` · by ${r.by}` : ''} · ${fmtDate(r.finishedAt || r.createdAt)}`,
      human: false,
    }));
  if (state.meta?.humanBaseline) {
    rows.push({
      label: state.meta.humanBaseline.label,
      mark: String(state.meta.humanBaseline.iq),
      pct: pctText(state.meta.humanBaseline.iq),
      sortVal: state.meta.humanBaseline.iq,
      sub: 'homo sapiens · reference',
      human: true,
    });
  }
  rows.sort((a, b) => b.sortVal - a.sortVal);
  $('ledger').innerHTML = rows.length
    ? rows.map((r, i) => `
      <div class="ledger-row ${r.human ? 'human' : ''}">
        <span class="rank">${String(i + 1).padStart(2, '0')}</span>
        <span class="who">${r.human ? `<em>${esc(r.label)}</em>` : esc(r.label)}</span>
        <span class="leader"></span>
        <span class="sub">${esc(r.sub)}</span>
        <span class="pct">${esc(r.pct)}</span>
        <span class="mark">${esc(r.mark)}</span>
      </div>`).join('')
    : '<div class="ledger-empty">No completed examinations yet.</div>';
}

/* ── overlay ── */
async function openOverlay(id) {
  state.openRun = id;
  $('overlay').hidden = false;
  await loadOverlay(id);
}
async function loadOverlay(id) {
  const { run, events } = await fetch(`/api/runs/${id}`).then((r) => r.json());
  $('overlay-title').textContent = `${run.label} — № ${run.id}`;
  $('overlay-body').innerHTML = events.map((ev) => {
    const time = new Date(ev.t).toLocaleTimeString();
    let body = '';
    if (ev.type === 'question_shown') body = `Question ${ev.question} presented · ${fmtClock(ev.secondsRemaining)} on the clock<img src="/shots/${id}/${ev.screenshot}" loading="lazy" />`;
    else if (ev.type === 'answer_chosen') body = `<span class="pick">→ ${ev.answer}</span> ${ev.fallback ? '(fallback guess)' : ''} in ${ev.latencyMs != null ? `${(ev.latencyMs / 1000).toFixed(1)}s` : '—'}<div class="ev-body">${esc(ev.rationale || '')}</div>`;
    else if (ev.type === 'score') body = `IQ ${ev.iq ?? '—'} ${ev.percentile ? `· ${ev.percentile} percentile` : ''} ${ev.note ? `(${ev.note})` : ''}<img src="/shots/${id}/${ev.screenshot}" loading="lazy" />`;
    else if (ev.type === 'provider_error' || ev.type === 'run_error') body = `<div class="ev-body">${esc(ev.error || '')}</div>`;
    return `<div class="ev"><span class="ev-time">${time}</span><div><div class="ev-type">${ev.type.replace(/_/g, ' ')}</div>${body}</div></div>`;
  }).join('') || '<p class="ledger-empty">No events yet.</p>';
}
$('overlay-close').addEventListener('click', () => { $('overlay').hidden = true; state.openRun = null; });
$('overlay').addEventListener('click', (e) => { if (e.target === $('overlay')) { $('overlay').hidden = true; state.openRun = null; } });

/* ── launch ── */
$('launch-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('launch-btn');
  const note = $('launch-note');
  btn.disabled = true;
  note.textContent = 'seating candidate…';
  try {
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: $('f-provider').value,
        model: $('f-model').value,
        label: $('f-label').value,
        effort: $('effort-field').style.display === 'none' ? undefined : $('f-effort').value || undefined,
        apiKey: $('f-key').value || undefined,
      }),
    });
    const data = await res.json();
    note.textContent = res.ok ? `candidate № ${data.id} seated.` : `refused: ${data.error}`;
  } catch (err) {
    note.textContent = `refused: ${err.message}`;
  } finally {
    btn.disabled = false;
    setTimeout(() => { note.textContent = ''; }, 6000);
  }
});

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

boot();
