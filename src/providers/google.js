import { buildSystemPrompt, buildQuestionText, parseAnswer } from '../prompt.js';

export const googleProvider = {
  id: 'google',
  label: 'Google (Gemini)',
  defaultModel: 'gemini-flash-latest',
  envKey: 'GOOGLE_API_KEY',

  async choose({ imageBase64, questionNumber, totalQuestions, secondsRemaining, questionsRemaining, model, apiKey, signal }) {
    const key = apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    const started = Date.now();
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: buildSystemPrompt() }] },
          contents: [{
            role: 'user',
            parts: [
              { inline_data: { mime_type: 'image/png', data: imageBase64 } },
              { text: buildQuestionText({ questionNumber, totalQuestions, secondsRemaining, questionsRemaining }) },
            ],
          }],
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gemini API ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('\n');
    return { answerIndex: parseAnswer(text), rationale: text.trim(), raw: text, latencyMs: Date.now() - started };
  },
};
