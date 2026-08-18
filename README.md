# IQ × Board — an examination hall for machine minds

An arena where LLM agents sit the **official Mensa Norway online IQ test** (the practice
test linked by **Mensa Sweden** at mensa.se/provtest): 35 visual matrix puzzles, 25 minutes,
six alternatives per question. Every agent gets its **own isolated browser session**
(Playwright context), sees each puzzle as a screenshot, must click one of the six answers,
is told the **live clock and pacing budget** before every question, and gets scored by
Mensa's own scoring service at the end.

A live black-and-white dashboard shows every run in real time: current question screenshot,
answer bubbles, the model's reasoning, the countdown, and a leaderboard with a human
reference score.

## Providers

| Provider  | Default model      | Key env var         |
|-----------|--------------------|---------------------|
| Anthropic | `claude-opus-4-8`  | `ANTHROPIC_API_KEY` |
| OpenAI    | `gpt-5.1`          | `OPENAI_API_KEY`    |
| xAI       | `grok-4`           | `XAI_API_KEY`       |
| Google    | `gemini-2.5-pro`   | `GOOGLE_API_KEY`    |
| random    | coin-flip baseline | — (no key)          |

Any model ID can be typed into the launcher; keys can also be pasted per-run (held in
memory only, never persisted). Anthropic runs support the `effort` parameter.

## Run locally

```sh
npm install
npx playwright install chromium
ADMIN_TOKEN=changeme ANTHROPIC_API_KEY=sk-... node src/server.js
# open http://localhost:3000
```

## Configuration

| Env var               | Meaning                                              |
|-----------------------|------------------------------------------------------|
| `ADMIN_TOKEN`         | Required header to launch runs (viewing is public)   |
| `MAX_CONCURRENT_RUNS` | Parallel browser sessions (default 2)                |
| `HUMAN_LABEL` / `HUMAN_IQ` | Leaderboard human baseline (default Simon / 138)|
| `DATA_DIR`            | Where runs, events, and screenshots persist          |
| `PORT`                | HTTP port (default 3000)                             |

## Deploy (Railway)

Ships with a Dockerfile on the Playwright base image:

```sh
railway init && railway up
railway variables --set ADMIN_TOKEN=... --set ANTHROPIC_API_KEY=...
railway domain
```

## Be polite

test.mensa.no is a free public service run by Mensa Norway. Keep concurrency low
(default 2), don't hammer it, and treat scores as indicative — the site itself says the
online test is practice, not an official assessment.
