# Claude için Backend Promptu

Aşağıdaki bölümün **tamamını** kopyalayıp Claude'a (claude.ai veya Claude Code) yapıştır.
Claude Code kullanıyorsan önce terminalde `canary-demo` klasörünü aç; böylece `src/types.ts` dosyasını kendisi okuyabilir.

---

## PROMPT (buradan itibaren kopyala)

I'm building a demo of **Canary** — an AI QA engineer that reads a web app's source code, infers the critical user flows, generates Playwright end-to-end tests for them, runs them against the live app, and traces failures back to the exact line of code.

The **frontend is already finished** (React + Vite, folder `canary-demo/`). I need you to build the **backend** in a new folder `canary-demo/server/` using **Node.js + TypeScript + Express**. Keep it simple and demo-reliable; this will be shown live on stage.

### API contract (MUST match exactly — the UI depends on it)

1. `POST /api/scans`
   - body: `{ "repoUrl": string, "appUrl": string }`
   - response: `{ "scanId": string }`
2. `GET /api/scans/:scanId/events`
   - **Server-Sent Events** stream (`Content-Type: text/event-stream`).
   - Each message is `data: <JSON>\n\n` where JSON is one `ScanEvent` (below).
   - The stream ends after the `done` event.
3. Enable CORS for `http://localhost:5173`.
4. Port: `8787`.

The exact TypeScript types are in `canary-demo/src/types.ts`. Copy them into the server. Summary:

```ts
type ScanEvent =
  | { type: 'scan_start'; repo: string; branch: string; totalFiles: number }
  | { type: 'file'; path: string }                         // one per source file read
  | { type: 'flow'; flow: Flow }                           // one per inferred user flow
  | { type: 'log'; level: 'info'|'warn'|'error'|'success'|'ai'; message: string }
  | { type: 'test_start'; flowId: string }
  | { type: 'step'; flowId: string; stepId: string; status: 'running'|'passed'|'failed'|'skipped' }
  | { type: 'test_result'; flowId: string; status: 'passed'|'failed'; durationMs: number; failure?: Failure }
  | { type: 'done'; summary: { files: number; flows: number; passed: number; failed: number; coverage: number; durationMs: number } };

interface Flow { id: string; name: string; description: string; priority: 'critical'|'high'|'medium';
  files: string[]; steps: { id: string; label: string; url: string; view: View; target?: string }[] }
// View is one of: 'login'|'signup'|'search'|'product'|'cart'|'checkout'|'checkout-error'|'orders'|'reset'
// (the UI renders a mock page for each view; pick the closest one)

interface Failure { flowId: string; stepId: string; title: string; expected: string; actual: string;
  file: string; line: number; code: { n: number; text: string; bad?: boolean }[];
  explanation: string; commit: { sha: string; message: string; author: string; when: string };
  fix: { before: string; after: string } }
```

Event order: `scan_start` → many `file` → many `flow` → for each flow: `test_start` → `step`(running/passed/failed/skipped)… → `test_result` → finally `done`. Interleave `log` events freely (the UI shows them in a terminal panel; `level: 'ai'` is shown in purple as "AI thinking").

### What the backend should actually do

1. **Clone** the repo (`simple-git`, shallow clone into a temp dir). Emit a `file` event for each relevant source file (`.ts/.tsx/.js/.jsx`, skip node_modules, max ~40 files), with a small delay (~120 ms) so it looks live.
2. **Infer flows with Gemini**: send the file tree + contents of route/page/API files to Gemini (`@google/genai`, model `gemini-2.5-flash`, JSON output mode) and ask it to return 5–7 `Flow` objects matching the schema above. API key from `process.env.GEMINI_API_KEY` (in `server/.env`).
3. **Run tests**: for each flow, generate a Playwright script with Gemini and run it against `appUrl` using `playwright` (chromium, headless). Emit `step` events as steps run.
4. **On failure**: ask Gemini to locate the root cause in the source (file, line, ~10 lines of code with the bad line marked `bad: true`), write an explanation, and suggest a one-line fix. Use `git log -1 -- <file>` for the `commit` field.

### Demo-safety requirements (important)

- If **any** step throws (clone fails, Gemini error, Playwright error), do not crash. Emit a `log` with `level: 'warn'` and continue with sensible fallback data.
- Add an env flag `DEMO_SCRIPTED=1`. When set, skip real work and replay a scripted event sequence. You can import the scenario from `../src/scenario.ts` (FILES, FLOWS, CHECKOUT_FAILURE). This is the safety net for stage.
- Include `server/README.md` with setup steps: `npm install`, `npx playwright install chromium`, `.env` with `GEMINI_API_KEY=...`, and `npm run dev`.

### Connecting to the frontend

The frontend reads `VITE_API_URL`. To connect, create `canary-demo/.env.local` with:
```
VITE_API_URL=http://localhost:8787
```
If the backend is down, the frontend automatically falls back to its built-in scripted run, so nothing breaks on stage.

Please give me the full code for every file, plus the exact commands to run it on **Windows (PowerShell)**.

## PROMPT SONU
