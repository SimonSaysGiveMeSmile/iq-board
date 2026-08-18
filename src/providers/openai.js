import { buildSystemPrompt, buildQuestionText, parseAnswer } from '../prompt.js';

// OpenAI-compatible chat/completions adapter. Covers OpenAI and xAI (Grok),
// plus any other provider exposing the same wire format via baseURL.
function makeOpenAICompatible({ id, label, baseURL, defaultModel, envKey }) {
  return {
    id,
    label,
    defaultModel,
    envKey,

    async choose({ imageBase64, questionNumber, totalQuestions, secondsRemaining, questionsRemaining, model, apiKey, signal }) {
      const key = apiKey || process.env[envKey];
      const started = Date.now();
      const res = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: buildSystemPrompt() },
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
                { type: 'text', text: buildQuestionText({ questionNumber, totalQuestions, secondsRemaining, questionsRemaining }) },
              ],
            },
          ],
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`${label} API ${res.status}: ${body.slice(0, 300)}`);
      }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content ?? '';
      return { answerIndex: parseAnswer(text), rationale: String(text).trim(), raw: text, latencyMs: Date.now() - started };
    },
  };
}

export const openaiProvider = makeOpenAICompatible({
  id: 'openai',
  label: 'OpenAI (GPT)',
  baseURL: 'https://api.openai.com/v1',
  defaultModel: 'gpt-5.5',
  envKey: 'OPENAI_API_KEY',
});

export const xaiProvider = makeOpenAICompatible({
  id: 'xai',
  label: 'xAI (Grok)',
  baseURL: 'https://api.x.ai/v1',
  defaultModel: 'grok-4.6',
  envKey: 'XAI_API_KEY',
});
