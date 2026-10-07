import type { Healing, ScanEvent } from './types';
import { CHECKOUT_FAILURE, FILES, FLOWS, HEAL_DEMO, TR_AUDIT } from './scenario';

const API_URL = import.meta.env.VITE_API_URL as string | undefined;

export const usingBackend = Boolean(API_URL);

const params = new URLSearchParams(window.location.search);
const SPEED = Number(params.get('speed') ?? '1') || 1;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms / SPEED);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    });
  });

/** Fully scripted run — used when no backend is configured (and as a fallback on stage). */
async function runMock(repo: string, emit: (e: ScanEvent) => void, signal: AbortSignal) {
  const started = Date.now();
  emit({ type: 'scan_start', repo, branch: 'main', totalFiles: FILES.length });
  emit({ type: 'log', level: 'info', message: `${repo} klonlanıyor (dal: main)…` });
  await sleep(900, signal);
  emit({ type: 'log', level: 'info', message: 'Algılandı: Next.js 15 · TypeScript · Prisma · iyzico' });
  await sleep(500, signal);
  emit({ type: 'log', level: 'ai', message: 'Geliştiricinin niyetini anlamak için kaynak kod okunuyor…' });

  for (const f of FILES) {
    emit({ type: 'file', path: f });
    await sleep(140, signal);
  }
  emit({ type: 'log', level: 'success', message: `${FILES.length} dosya indekslendi · 2.814 satır · 31 bileşen` });
  emit({ type: 'log', level: 'info', message: '🇹🇷 Türkiye uyum taraması: tüm kaynak kodda İ/ı, ₺, UTC tarih ve KVKK riskleri aranıyor…' });
  await sleep(900, signal);
  emit({ type: 'tr_audit', report: TR_AUDIT });
  emit({
    type: 'log',
    level: 'warn',
    message: `🇹🇷 Türkiye uyum skoru ${TR_AUDIT.score}/100 — ${TR_AUDIT.filesScanned} dosyada ${TR_AUDIT.items.length} risk türü, ${TR_AUDIT.items.reduce((n, it) => n + it.count, 0)} konum (yapay zeka kullanılmadı)`,
  });
  await sleep(500, signal);
  emit({ type: 'log', level: 'ai', message: 'Rotalar, formlar ve API dosyalarından kullanıcı akışları çıkarılıyor (Türkiye profili: Türkçe karakter, ₺ ve TR format kontrolleri dahil)…' });

  for (const flow of FLOWS) {
    await sleep(420, signal);
    emit({ type: 'flow', flow });
    emit({ type: 'log', level: 'info', message: `Akış bulundu${flow.region === 'tr' ? ' 🇹🇷' : ''}: ${flow.name} (${flow.steps.length} adım)` });
  }
  await sleep(600, signal);
  emit({ type: 'log', level: 'ai', message: `${FLOWS.length} Playwright testi yazıldı · headless Chromium başlatılıyor (tr-TR, Europe/Istanbul)` });
  await sleep(700, signal);

  let passed = 0;
  let failed = 0;
  for (const flow of FLOWS) {
    const t0 = Date.now();
    emit({ type: 'test_start', flowId: flow.id });
    emit({ type: 'log', level: 'info', message: `▶ ${flow.name}` });
    const isBug = flow.id === CHECKOUT_FAILURE.flowId;
    let broken = false;
    const healed: Healing[] = [];
    for (const step of flow.steps) {
      if (broken) {
        emit({ type: 'step', flowId: flow.id, stepId: step.id, status: 'skipped' });
        continue;
      }
      emit({ type: 'step', flowId: flow.id, stepId: step.id, status: 'running' });
      await sleep(isBug ? 1100 : 650, signal);
      if (isBug && step.id === CHECKOUT_FAILURE.stepId) {
        emit({ type: 'step', flowId: flow.id, stepId: step.id, status: 'failed' });
        emit({ type: 'log', level: 'error', message: `✗ ${flow.name} › ${step.label}: ${CHECKOUT_FAILURE.actual}` });
        emit({ type: 'log', level: 'ai', message: '🩹 Kendini onarma: Canary sayfanın gerçek halini okuyup bu adımı yeniden yazıyor…' });
        await sleep(1000, signal);
        emit({ type: 'log', level: 'warn', message: '🩹 Onarılamadı — "Siparişi Onayla" butonu devre dışı ve toplam NaN; bu test değil, gerçek bir uygulama hatası.' });
        broken = true;
      } else if (flow.id === HEAL_DEMO.flowId && step.id === HEAL_DEMO.healing.stepId) {
        emit({ type: 'step', flowId: flow.id, stepId: step.id, status: 'failed' });
        emit({ type: 'log', level: 'error', message: `✗ ${flow.name} › ${step.label}: ${HEAL_DEMO.error}` });
        emit({ type: 'log', level: 'ai', message: '🩹 Kendini onarma: Canary sayfanın gerçek halini okuyup bu adımı yeniden yazıyor…' });
        await sleep(1200, signal);
        emit({ type: 'step', flowId: flow.id, stepId: step.id, status: 'running' });
        await sleep(500, signal);
        emit({ type: 'step', flowId: flow.id, stepId: step.id, status: 'passed' });
        emit({ type: 'log', level: 'success', message: `🩹 Test kendini onardı: ${HEAL_DEMO.healing.reason}` });
        healed.push(HEAL_DEMO.healing);
      } else {
        emit({ type: 'step', flowId: flow.id, stepId: step.id, status: 'passed' });
      }
    }
    const durationMs = Date.now() - t0;
    if (broken) {
      failed++;
      await sleep(400, signal);
      emit({ type: 'log', level: 'ai', message: `Hata kaynak koda kadar izleniyor… ${CHECKOUT_FAILURE.file}:${CHECKOUT_FAILURE.line} (commit ${CHECKOUT_FAILURE.commit.sha})` });
      await sleep(900, signal);
      emit({ type: 'test_result', flowId: flow.id, status: 'failed', durationMs, failure: CHECKOUT_FAILURE, ...(healed.length ? { healed } : {}) });
    } else {
      passed++;
      emit({ type: 'test_result', flowId: flow.id, status: 'passed', durationMs, ...(healed.length ? { healed } : {}) });
      emit({ type: 'log', level: 'success', message: `✓ ${flow.name} (${(durationMs / 1000).toFixed(1)} sn)` });
    }
    await sleep(250, signal);
  }

  emit({
    type: 'done',
    summary: {
      files: FILES.length,
      flows: FLOWS.length,
      passed,
      failed,
      coverage: 94,
      durationMs: Date.now() - started,
    },
  });
}

/** Real backend: POST /api/scans → { scanId }, then SSE stream GET /api/scans/:id/events */
async function runBackend(repo: string, appUrl: string, profile: 'tr' | 'global', emit: (e: ScanEvent) => void, signal: AbortSignal) {
  const res = await fetch(`${API_URL}/api/scans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoUrl: repo, appUrl, profile }),
    signal,
  });
  if (!res.ok) throw new Error(`Backend error ${res.status}`);
  const { scanId } = (await res.json()) as { scanId: string };

  await new Promise<void>((resolve, reject) => {
    const es = new EventSource(`${API_URL}/api/scans/${scanId}/events`);
    signal.addEventListener('abort', () => {
      es.close();
      reject(new DOMException('aborted', 'AbortError'));
    });
    es.onmessage = (msg) => {
      const ev = JSON.parse(msg.data) as ScanEvent;
      emit(ev);
      if (ev.type === 'done') {
        es.close();
        resolve();
      }
    };
    es.onerror = () => {
      es.close();
      reject(new Error('Event stream disconnected'));
    };
  });
}

export async function runScan(
  repo: string,
  appUrl: string,
  profile: 'tr' | 'global',
  emit: (e: ScanEvent) => void,
  signal: AbortSignal,
) {
  if (!API_URL || params.get('mock') === '1') return runMock(repo, emit, signal);
  try {
    await runBackend(repo, appUrl, profile, emit, signal);
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    // Stage safety net: if the backend dies, fall back to the scripted run.
    console.warn('Backend failed, falling back to mock run', err);
    emit({ type: 'log', level: 'warn', message: "Backend'e ulaşılamadı — kayıtlı demo çalıştırmasına geçiliyor" });
    await runMock(repo, emit, signal);
  }
}
