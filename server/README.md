# Canary — backend

Node.js + TypeScript + Express server for the Canary demo. It clones a repo, asks Gemini to infer the
critical user flows, generates and runs Playwright tests against the live app, and traces failures
back to the exact line of code. Results stream to the UI over Server-Sent Events.

## Requirements

- Node.js 20+ (`node -v`)
- Git on PATH (`git --version`) — used for cloning and `git log`
- A Gemini API key (https://aistudio.google.com/apikey)

## Setup (Windows PowerShell)

```powershell
cd canary-demo\server
npm install
npx playwright install chromium
Copy-Item .env.example .env
notepad .env          # set GEMINI_API_KEY=...
npm run dev
```

You should see:

```
  🐤 Canary backend on http://localhost:8787
  mode: live   gemini key: yes
```

Connect the frontend (in a second PowerShell window):

```powershell
cd canary-demo
Set-Content .env.local "VITE_API_URL=http://localhost:8787"
npm run dev
```

Restart the Vite dev server after creating `.env.local` — Vite only reads env files at startup.

## Stage safety net: scripted mode

Replays a fixed scan from `../src/scenario.ts` (`FILES`, `FLOWS`, `CHECKOUT_FAILURE`). No network,
no browser, no Gemini — it cannot fail.

```powershell
npm run dev:scripted
```

or set `DEMO_SCRIPTED=1` in `.env`. If `scenario.ts` can't be imported, a built-in copy is used.

## API

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/scans` | body `{ repoUrl, appUrl }` → `{ scanId }` |
| GET | `/api/scans/:scanId/events` | SSE stream of `ScanEvent`s, ends after `done` |
| GET | `/api/health` | `{ ok, scripted, gemini }` — quick pre-show check |

## How it works

1. **Clone** — shallow `git clone` into a temp dir; picks up to 40 `.ts/.tsx/.js/.jsx` files
   (skips `node_modules`, build output, tests, configs), prioritising pages/routes/API handlers.
2. **Infer flows** — file tree + route/page/API sources go to `gemini-2.5-flash` in JSON mode;
   the answer is validated and normalised (unknown views mapped to the closest one, bad file paths dropped).
3. **Generate tests** — for each flow Gemini writes the Playwright actions per step. The server runs
   them with a small interpreter (goto / click / fill / press / expect…) in headless Chromium instead of
   `eval`-ing generated code, so a bad generation can't hang or crash the demo and each `step` event
   fires exactly when that step runs. A readable copy is saved to `generated-tests/<flow>.spec.ts`.
4. **Trace failures** — Gemini gets the flow's source with line numbers and the test error, and returns
   file, line, explanation and a one-line fix. The code snippet is cut from the real file (not the LLM),
   and the commit comes from `git log -1 -- <file>`.

## Fallbacks (nothing crashes)

| If this fails | What happens |
| --- | --- |
| Clone | `warn` log, scan continues with no source files |
| Gemini (no key, error, timeout) | heuristic flows from file names, basic navigation tests, best-effort root cause |
| Chromium launch | `warn` log, steps run as HTTP smoke checks of each URL |
| Anything unexpected | `warn` log and a `done` event so the UI always finishes |

## Troubleshooting

- **`npm` is blocked by execution policy** → use `npm.cmd install` / `npm.cmd run dev`, or run
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.
- **Port 8787 in use** → `Get-NetTCPConnection -LocalPort 8787 | Select OwningProcess`, then
  `Stop-Process -Id <pid>`; or set `PORT=` in `.env` (and update `VITE_API_URL`).
- **Private repo** → use an HTTPS URL with a token: `https://<token>@github.com/org/repo.git`.
