import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt, buildQuestionText, parseAnswer } from '../prompt.js';

export const anthropicProvider = {
  id: 'anthropic',
  label: 'Anthropic (Claude)',
  defaultModel: 'claude-opus-4-8',
  envKey: 'ANTHROPIC_API_KEY',

  async choose({ imageBase64, questionNumber, totalQuestions, secondsRemaining, questionsRemaining, model, apiKey, effort, signal }) {
    const client = new Anthropic({ apiKey: apiKey || process.env.ANTHROPIC_API_KEY });
    const isFable = model.startsWith('claude-fable') || model.startsWith('claude-mythos');
    const started = Date.now();

    const base = {
      model,
      max_tokens: 16000,
      output_config: { effort: effort || 'medium' },
      system: buildSystemPrompt(),
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
          { type: 'text', text: buildQuestionText({ questionNumber, totalQuestions, secondsRemaining, questionsRemaining }) },
        ],
      }],
    };

    let response;
    if (isFable) {
      // Fable 5: thinking is always on (omit the param); opt into server-side refusal fallbacks.
      response = await client.beta.messages.create({
        ...base,
        betas: ['server-side-fallback-2026-06-01'],
        fallbacks: [{ model: 'claude-opus-4-8' }],
      }, { signal });
    } else {
      response = await client.messages.create({ ...base, thinking: { type: 'adaptive' } }, { signal });
    }

    if (response.stop_reason === 'refusal') {
      return { answerIndex: null, rationale: '[refusal] model declined this request', raw: '', latencyMs: Date.now() - started };
    }
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return { answerIndex: parseAnswer(text), rationale: text.trim(), raw: text, latencyMs: Date.now() - started };
  },
};
