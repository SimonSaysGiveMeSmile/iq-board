import { anthropicProvider } from './anthropic.js';
import { openaiProvider, xaiProvider } from './openai.js';
import { googleProvider } from './google.js';

// No-API baseline: answers at random. Useful for verifying the pipeline and as
// a chance-level reference on the leaderboard.
const randomProvider = {
  id: 'random',
  label: 'Random baseline (no API)',
  defaultModel: 'coin-flip',
  envKey: null,
  async choose() {
    const answerIndex = Math.floor(Math.random() * 6);
    return { answerIndex, rationale: 'Baseline: uniform random guess.', raw: '', latencyMs: 0 };
  },
};

export const providers = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  xai: xaiProvider,
  google: googleProvider,
  random: randomProvider,
};

export function providerMeta() {
  return Object.values(providers).map((p) => ({
    id: p.id,
    label: p.label,
    defaultModel: p.defaultModel,
    hasEnvKey: p.envKey ? Boolean(process.env[p.envKey] || (p.id === 'google' && process.env.GEMINI_API_KEY)) : true,
  }));
}
