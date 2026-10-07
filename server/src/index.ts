import 'dotenv/config';
import cors from 'cors';
import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { hasGeminiKey } from './gemini.ts';
import { normalizeRepoUrl } from './repo.ts';
import { runRealScan } from './scanner.ts';
import { runScriptedScan } from './scripted.ts';
import type { LogLevel, ScanEvent } from './types.ts';
import { AbortedError, errMsg, type ScanContext } from './util.ts';

const PORT = Number(process.env.PORT) || 8787;
const isScripted = () => ['1', 'true', 'yes'].includes(String(process.env.DEMO_SCRIPTED ?? '').toLowerCase());

interface ScanRequest {
  repoUrl: string;
  appUrl: string;
  profile: 'tr' | 'global';
  createdAt: number;
}
const scans = new Map<string, ScanRequest>();

// Forget old scans so memory doesn't grow during a long rehearsal day.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, s] of scans) if (s.createdAt < cutoff) scans.delete(id);
}, 10 * 60 * 1000).unref();

const app = express();
app.use(cors({ origin: /^http:\/\/(localhost|127\.0\.0\.1):\d+$/ }));
app.use(express.json({ limit: '100kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, scripted: isScripted(), gemini: hasGeminiKey() });
});

app.post('/api/scans', (req: Request, res: Response) => {
  const repoUrl = typeof req.body?.repoUrl === 'string' ? normalizeRepoUrl(req.body.repoUrl) : '';
  let appUrl = typeof req.body?.appUrl === 'string' ? req.body.appUrl.trim() : '';
  if (appUrl && !/^https?:\/\//i.test(appUrl)) {
    appUrl = (/^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(appUrl) ? 'http://' : 'https://') + appUrl;
  }
  if (!repoUrl || !appUrl) {
    res.status(400).json({ error: 'repoUrl and appUrl are required' });
    return;
  }
  const scanId = randomUUID();
  // Canary TR is the default; send { "profile": "global" } for the original English behaviour.
  const profile = req.body?.profile === 'global' ? 'global' : 'tr';
  scans.set(scanId, { repoUrl, appUrl, profile, createdAt: Date.now() });
  console.log(`[scan ${scanId.slice(0, 8)}] created repo=${repoUrl} app=${appUrl} profile=${profile}`);
  res.json({ scanId });
});

app.get('/api/scans/:scanId/events', async (req: Request, res: Response) => {
  const scanId = req.params.scanId;
  const scan = scans.get(scanId);
  if (!scan) {
    res.status(404).json({ error: 'unknown scanId' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(': connected\n\n');

  let closed = false;
  req.on('close', () => {
    closed = true;
  });
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15_000);

  const tag = `[scan ${scanId.slice(0, 8)}]`;
  const emit = (event: ScanEvent) => {
    if (closed) throw new AbortedError();
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const ctx: ScanContext = {
    scanId,
    repoUrl: scan.repoUrl,
    appUrl: scan.appUrl,
    profile: scan.profile,
    emit,
    log: (level: LogLevel, message: string) => {
      console.log(`${tag} ${level.padEnd(7)} ${message}`);
      if (!closed) res.write(`data: ${JSON.stringify({ type: 'log', level, message })}\n\n`);
    },
    isAborted: () => closed,
  };

  const mode = isScripted() ? 'scripted' : 'live';
  console.log(`${tag} stream opened (${mode})`);
  try {
    if (isScripted()) await runScriptedScan(ctx);
    else await runRealScan(ctx);
  } catch (e) {
    if (e instanceof AbortedError) {
      console.log(`${tag} client disconnected — scan stopped`);
    } else {
      // Last line of defence: something unexpected escaped. Finish the stream cleanly.
      console.error(`${tag} unexpected error`, e);
      if (!closed) {
        ctx.log('warn', `Scan stopped early: ${errMsg(e)}`);
        res.write(
          `data: ${JSON.stringify({
            type: 'done',
            summary: { files: 0, flows: 0, passed: 0, failed: 0, coverage: 0, durationMs: 0 },
          })}\n\n`,
        );
      }
    }
  } finally {
    clearInterval(heartbeat);
    if (!closed) res.end();
    console.log(`${tag} stream closed`);
  }
});

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

app.listen(PORT, () => {
  console.log(`\n  🐤 Canary TR backend on http://localhost:${PORT}`);
  console.log(`  mode: ${isScripted() ? 'SCRIPTED (DEMO_SCRIPTED=1)' : 'live'}   gemini key: ${hasGeminiKey() ? 'yes' : 'MISSING'}\n`);
});
