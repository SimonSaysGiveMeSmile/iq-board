// Builds the instruction text sent to every model, provider-agnostic.

export function buildSystemPrompt() {
  return [
    'You are an AI agent taking the official Mensa Norway online IQ test (the practice test linked by Mensa Sweden).',
    'The test has 35 visual pattern puzzles and a strict 25-minute overall time limit.',
    'Each puzzle is a 3x3 grid of figures with the bottom-right figure missing.',
    'Below the grid are 6 candidate answer images. Label them A, B, C, D, E, F reading left to right (top to bottom if wrapped).',
    'Exactly one candidate completes the pattern that connects the figures (across rows, columns, or both).',
    'Puzzles get progressively harder. Answers are weighted equally: one point each, no penalty for wrong answers, no bonus for finishing early.',
    'If you are unsure, commit to your best guess quickly rather than burning time.',
    '',
    'Respond with 1-3 short sentences describing the pattern you identified, then on the last line output exactly:',
    'FINAL: <letter>',
    'where <letter> is one of A, B, C, D, E, F.',
  ].join('\n');
}

export function buildQuestionText({ questionNumber, totalQuestions, secondsRemaining, questionsRemaining }) {
  const perQuestion = questionsRemaining > 0 ? Math.floor(secondsRemaining / questionsRemaining) : secondsRemaining;
  return [
    `Question ${questionNumber} of ${totalQuestions}.`,
    `Time remaining on the test clock: ${formatClock(secondsRemaining)} (${secondsRemaining}s) for ${questionsRemaining} remaining questions — about ${perQuestion}s per question. Pace yourself accordingly.`,
    'The screenshot shows the puzzle grid and the 6 answer candidates (A-F, left to right).',
  ].join('\n');
}

export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

// Lenient extraction of the chosen answer from model text. Returns 0-5 or null.
export function parseAnswer(text) {
  if (!text) return null;
  const final = text.match(/FINAL\s*[:\-]?\s*\(?([A-F])\)?/i);
  if (final) return LETTERS.indexOf(final[1].toUpperCase());
  // Fall back to the last standalone A-F letter in the text.
  const all = [...text.matchAll(/(?:^|[\s"'(*_`])([A-F])(?:[\s"')*_.,!`]|$)/gim)];
  if (all.length) return LETTERS.indexOf(all[all.length - 1][1].toUpperCase());
  return null;
}

export { LETTERS };
