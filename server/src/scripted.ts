import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Failure, Flow, Healing, TrAuditReport } from './types.ts';
import { sleep, type ScanContext } from './util.ts';
import { BUILTIN_AUDIT, BUILTIN_FAILURE, BUILTIN_FILES, BUILTIN_FLOWS, BUILTIN_HEAL } from './builtinScenario.ts';

const PRIORITY_TR = { critical: 'kritik', high: 'yüksek', medium: 'orta' } as const;

interface Scenario {
  files: string[];
  flows: Flow[];
  failure: Failure | null;
  audit: TrAuditReport | null;
  heal: { flowId: string; error: string; healing: Healing } | null;
  source: string;
}

let cached: Scenario | null = null;

/** Load FILES / FLOWS / CHECKOUT_FAILURE from the frontend's src/scenario.ts; fall back to a built-in copy. */
async function loadScenario(log: ScanContext['log']): Promise<Scenario> {
  if (cached) return cached;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const scenarioPath = path.resolve(here, '..', '..', 'src', 'scenario.ts');
  try {
    const mod: Record<string, unknown> = await import(pathToFileURL(scenarioPath).href);
    const rawFiles = (mod.FILES ?? []) as unknown[];
    const files = rawFiles
      .map((f) => (typeof f === 'string' ? f : (f as { path?: string })?.path))
      .filter((p): p is string => typeof p === 'string');
    const flows = (mod.FLOWS ?? []) as Flow[];
    const failure = (mod.CHECKOUT_FAILURE ?? null) as Failure | null;
    if (!files.length || !Array.isArray(flows) || !flows.length) throw new Error('FILES/FLOWS missing or empty');
    const audit = (mod.TR_AUDIT ?? null) as TrAuditReport | null;
    const heal = (mod.HEAL_DEMO ?? null) as Scenario['heal'];
    cached = { files, flows, failure, audit, heal, source: 'src/scenario.ts' };
  } catch (e) {
    log('warn', `../src/scenario.ts yüklenemedi (${e instanceof Error ? e.message : e}); yerleşik senaryo kullanılıyor.`);
    cached = { files: BUILTIN_FILES, flows: BUILTIN_FLOWS, failure: BUILTIN_FAILURE, audit: BUILTIN_AUDIT, heal: BUILTIN_HEAL, source: 'built-in' };
  }
  return cached;
}

/** Replays a fixed, believable scan. No network, no browser, no Gemini — cannot fail on stage. */
export async function runScriptedScan(ctx: ScanContext): Promise<void> {
  const started = Date.now();
  const { emit, log } = ctx;
  const sc = await loadScenario(log);
  const repo = ctx.repoUrl.replace(/\.git$/, '').replace(/^https?:\/\/(www\.)?github\.com\//i, '') || 'carsi-tr/magaza';

  log('info', `$ canary scan ${ctx.repoUrl || repo}`);
  await sleep(300);
  log('info', `${repo} klonlanıyor (sığ kopya)…`);
  await sleep(700);
  emit({ type: 'scan_start', repo, branch: 'main', totalFiles: sc.files.length });
  log('success', `${repo}@main klonlandı — ${sc.files.length} kaynak dosya seçildi`);

  for (const f of sc.files) {
    emit({ type: 'file', path: f });
    await sleep(120);
  }

  if (sc.audit) {
    log('info', '🇹🇷 Türkiye uyum taraması: tüm kaynak kodda İ/ı, ₺, UTC tarih ve KVKK riskleri aranıyor…');
    await sleep(900);
    emit({ type: 'tr_audit', report: sc.audit });
    const total = sc.audit.items.reduce((n, it) => n + it.count, 0);
    log('warn', `🇹🇷 Türkiye uyum skoru ${sc.audit.score}/100 — ${sc.audit.filesScanned} dosyada ${sc.audit.items.length} risk türü, ${total} konum (yapay zeka kullanılmadı)`);
    await sleep(400);
  }

  log('ai', 'Rotalar, sayfalar ve API dosyaları okunuyor; kritik kullanıcı akışları çıkarılıyor (Türkiye profili: Türkçe karakter, ₺ ve TR format kontrolleri dahil)…');
  await sleep(1200);
  log('ai', `${sc.flows.length} kullanıcı akışı bulundu${sc.flows.some((f) => f.region === 'tr') ? ` (${sc.flows.filter((f) => f.region === 'tr').length} tanesi Türkiye'ye özel)` : ''}; iş etkisine göre sıralandı.`);
  for (const flow of sc.flows) {
    emit({ type: 'flow', flow });
    log('info', `Akış [${PRIORITY_TR[flow.priority]}]${flow.region === 'tr' ? ' 🇹🇷' : ''} ${flow.name} — ${flow.steps.length} adım`);
    await sleep(350);
  }

  log('info', 'Headless Chromium başlatılıyor (dil: tr-TR, saat dilimi: Europe/Istanbul)…');
  await sleep(600);
  log('success', `Chromium hazır — ${ctx.appUrl} test ediliyor`);

  const failure = sc.failure;
  let passed = 0;
  let failed = 0;

  for (const flow of sc.flows) {
    emit({ type: 'test_start', flowId: flow.id });
    log('ai', `"${flow.name}" için Playwright testi yazılıyor…`);
    await sleep(500);
    const t0 = Date.now();
    const failsHere = failure && failure.flowId === flow.id;
    let hasFailed = false;

    const healed: Healing[] = [];
    for (const step of flow.steps) {
      if (hasFailed) {
        emit({ type: 'step', flowId: flow.id, stepId: step.id, status: 'skipped' });
        continue;
      }
      emit({ type: 'step', flowId: flow.id, stepId: step.id, status: 'running' });
      await sleep(450 + Math.round(Math.random() * 350));
      if (failsHere && step.id === failure!.stepId) {
        hasFailed = true;
        emit({ type: 'step', flowId: flow.id, stepId: step.id, status: 'failed' });
        log('error', `✗ ${flow.name} › ${step.label}: ${failure!.actual}`);
        log('ai', '🩹 Kendini onarma: Canary sayfanın gerçek halini okuyup bu adımı yeniden yazıyor…');
        await sleep(1000);
        log('warn', '🩹 Onarılamadı — "Siparişi Onayla" butonu devre dışı ve toplam NaN; bu test değil, gerçek bir uygulama hatası.');
      } else if (sc.heal && flow.id === sc.heal.flowId && step.id === sc.heal.healing.stepId) {
        emit({ type: 'step', flowId: flow.id, stepId: step.id, status: 'failed' });
        log('error', `✗ ${flow.name} › ${step.label}: ${sc.heal.error}`);
        log('ai', '🩹 Kendini onarma: Canary sayfanın gerçek halini okuyup bu adımı yeniden yazıyor…');
        await sleep(1200);
        emit({ type: 'step', flowId: flow.id, stepId: step.id, status: 'running' });
        await sleep(500);
        emit({ type: 'step', flowId: flow.id, stepId: step.id, status: 'passed' });
        log('success', `🩹 Test kendini onardı: ${sc.heal.healing.reason}`);
        healed.push(sc.heal.healing);
      } else {
        emit({ type: 'step', flowId: flow.id, stepId: step.id, status: 'passed' });
      }
    }

    // Failure's stepId didn't match any step: fail on the last one so the story still lands.
    if (failsHere && !hasFailed && flow.steps.length) {
      const last = flow.steps[flow.steps.length - 1];
      emit({ type: 'step', flowId: flow.id, stepId: last.id, status: 'failed' });
      hasFailed = true;
    }

    const durationMs = Date.now() - t0;
    if (hasFailed && failure) {
      failed++;
      log('ai', `"${flow.name}" hatası kaynak koda kadar izleniyor…`);
      await sleep(1100);
      log('ai', `Kök neden: ${failure.file}:${failure.line} — ${failure.title}`);
      emit({ type: 'test_result', flowId: flow.id, status: 'failed', durationMs, failure, ...(healed.length ? { healed } : {}) });
    } else {
      passed++;
      log('success', `✓ ${flow.name} geçti (${(durationMs / 1000).toFixed(1)} sn)`);
      emit({ type: 'test_result', flowId: flow.id, status: 'passed', durationMs, ...(healed.length ? { healed } : {}) });
    }
  }

  const covered = new Set(sc.flows.flatMap((f) => f.files));
  const coverage = Math.min(100, Math.round((covered.size / Math.max(1, sc.files.length)) * 100));
  log(failed ? 'warn' : 'success', `Bitti: ${sc.flows.length} akıştan ${passed} geçti, ${failed} başarısız.`);
  emit({
    type: 'done',
    summary: { files: sc.files.length, flows: sc.flows.length, passed, failed, coverage, durationMs: Date.now() - started },
  });
}
