import fs from 'node:fs';
import path from 'node:path';
import { providers } from './providers/index.js';
import { LETTERS } from './prompt.js';

const TEST_URL = 'https://test.mensa.no/';
const TOTAL_QUESTIONS = 35;
const TEST_SECONDS = 25 * 60;
// Hard ceiling for a single model call; also bounded by the per-question budget.
const MAX_CALL_MS = 120_000;

// Parses "24:31" -> seconds. Returns null when unreadable.
function parseClock(text) {
  const m = (text || '').match(/(\d+):(\d\d)/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// The site's page containers (.page_questions, .page_score) can have a
// zero-height bounding box even when shown, so Playwright's box-based
// visibility check reports them hidden. Test computed display instead.
function isDisplayed(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return Boolean(el) && getComputedStyle(el).display !== 'none';
  }, selector);
}

function waitDisplayed(page, selector, timeout) {
  return page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return Boolean(el) && getComputedStyle(el).display !== 'none';
    },
    selector,
    { timeout },
  );
}

// Click `clickSel` and wait for `expectSel` to become displayed, retrying the
// click a few times — the site's jQuery fade transitions can swallow a click.
async function clickUntil(page, clickSel, expectSel, attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    await page.locator(clickSel).first().click({ timeout: 10_000 }).catch(() => {});
    try {
      await waitDisplayed(page, expectSel, 10_000);
      return;
    } catch { /* retry the click */ }
  }
  throw new Error(`"${expectSel}" never became displayed after clicking "${clickSel}"`);
}

/**
 * Drives one full test session in its own isolated browser context.
 * Emits structured events through `emit(type, payload)`.
 * Returns { score, answers } — score.iq is null if the site couldn't score the run.
 */
export async function runTestSession({ browser, run, shotsDir, emit }) {
  const provider = providers[run.provider];
  if (!provider) throw new Error(`Unknown provider: ${run.provider}`);
  fs.mkdirSync(shotsDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 1400 },
    userAgent: undefined,
  });
  const page = await context.newPage();
  const answers = [];
  let startedAt = null;

  const secondsRemaining = async () => {
    const clock = parseClock(await page.locator('.testCountdown').first().innerText().catch(() => ''));
    if (clock !== null) return clock;
    return startedAt ? Math.max(0, TEST_SECONDS - Math.floor((Date.now() - startedAt) / 1000)) : TEST_SECONDS;
  };

  try {
    emit('navigating', { url: TEST_URL });
    await page.goto(TEST_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // Welcome page: pick the 18-50 age group, then start from the instructions page.
    // Clicks retry because the site animates page transitions with jQuery fades.
    await clickUntil(page, '.ageselect_1850', '#startTest');
    emit('instructions_shown', {});
    await page.waitForTimeout(750); // let the fade + handlers settle
    await clickUntil(page, '#startTest', '.page_questions');
    startedAt = Date.now();
    emit('test_started', { totalQuestions: TOTAL_QUESTIONS, testSeconds: TEST_SECONDS });

    for (let q = 0; q < TOTAL_QUESTIONS; q += 1) {
      // If the timer expired, the site jumps straight to scoring.
      if (await isDisplayed(page, '.page_score').catch(() => false)) {
        emit('time_expired', { atQuestion: q + 1 });
        break;
      }

      const qDiv = page.locator(`#question_${q}`);
      await waitDisplayed(page, `#question_${q}`, 30_000);
      // Wait for the puzzle image to actually render before screenshotting.
      await qDiv.locator('img.standardQuestionImage').first()
        .waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(250); // let lazy images settle

      const remaining = await secondsRemaining();
      const questionsRemaining = TOTAL_QUESTIONS - q;
      const shotFile = `q${String(q + 1).padStart(2, '0')}.png`;
      const shotPath = path.join(shotsDir, shotFile);
      await qDiv.screenshot({ path: shotPath });
      emit('question_shown', {
        question: q + 1, totalQuestions: TOTAL_QUESTIONS,
        secondsRemaining: remaining, screenshot: shotFile,
      });

      // Per-question budget: fair share of remaining time, min 8s, capped at MAX_CALL_MS.
      const budgetMs = Math.min(MAX_CALL_MS, Math.max(8_000, Math.floor((remaining / questionsRemaining) * 1000) - 3_000));
      const imageBase64 = fs.readFileSync(shotPath).toString('base64');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), budgetMs);

      let choice = null;
      let fallback = false;
      try {
        choice = await provider.choose({
          imageBase64,
          questionNumber: q + 1,
          totalQuestions: TOTAL_QUESTIONS,
          secondsRemaining: remaining,
          questionsRemaining,
          model: run.model,
          apiKey: run.apiKey,
          effort: run.effort,
          signal: controller.signal,
        });
      } catch (err) {
        emit('provider_error', { question: q + 1, error: String(err?.message || err).slice(0, 500) });
      } finally {
        clearTimeout(timer);
      }

      let answerIndex = choice?.answerIndex;
      if (answerIndex === null || answerIndex === undefined || answerIndex < 0 || answerIndex > 5) {
        answerIndex = Math.floor(Math.random() * 6);
        fallback = true;
      }

      await qDiv.locator(`.answer-button[data-answerid="${answerIndex}"]`).first().click({ timeout: 15_000 });
      answers.push({ question: q + 1, answer: LETTERS[answerIndex], fallback });
      emit('answer_chosen', {
        question: q + 1,
        answer: LETTERS[answerIndex],
        fallback,
        latencyMs: choice?.latencyMs ?? null,
        rationale: (choice?.rationale || (fallback ? 'No usable model answer — random fallback.' : '')).slice(0, 2000),
        secondsRemaining: await secondsRemaining(),
      });

      if (q < TOTAL_QUESTIONS - 1) {
        // Answering auto-advances with a fade; click Next only if it didn't.
        const advanced = await waitDisplayed(page, `#question_${q + 1}`, 4_000).then(() => true).catch(() => false);
        if (!advanced) {
          await qDiv.locator('.questionNext').click({ timeout: 15_000 }).catch(() => {});
          await waitDisplayed(page, `#question_${q + 1}`, 10_000).catch(() => {});
        }
      } else {
        await qDiv.locator('.questionFinish').click({ timeout: 15_000 });
        await page.waitForTimeout(500);
        if (await isDisplayed(page, '#endTestDialog').catch(() => false)) {
          await page.locator('#endTestDialog .btn-danger').click({ timeout: 10_000 }).catch(() => {});
        }
      }
    }

    emit('finishing', { answered: answers.length });
    await waitDisplayed(page, '.page_score', 60_000);
    const finalShot = path.join(shotsDir, 'result.png');

    // Wait for the scoring service to respond (IQ text, low-score note, or error).
    const score = { iq: null, percentile: null, note: null };
    try {
      await page.waitForFunction(() => {
        const iq = document.querySelector('.scoreIqText');
        const low = document.querySelector('.resultScoreLow');
        const err = document.querySelector('.resultScoreError');
        const vis = (el) => el && el.offsetParent !== null && (el.innerText || '').trim().length > 0;
        return vis(iq) || (low && low.offsetParent !== null) || (err && err.offsetParent !== null);
      }, { timeout: 180_000 });

      const iqText = await page.locator('.scoreIqText').first().innerText().catch(() => '');
      const iqMatch = iqText.match(/\d+/);
      if (iqMatch) {
        score.iq = Number(iqMatch[0]);
        score.percentile = (await page.locator('#scorePercentile').innerText().catch(() => '')).trim() || null;
      } else if (await page.locator('.resultScoreLow').isVisible().catch(() => false)) {
        score.note = 'below_measurable_range';
      } else {
        score.note = 'scoring_error';
      }
    } catch {
      score.note = 'scoring_timeout';
    }
    await page.screenshot({ path: finalShot, fullPage: false }).catch(() => {});
    emit('score', { ...score, screenshot: 'result.png' });
    return { score, answers };
  } finally {
    await context.close().catch(() => {});
  }
}
