import { analyzeWithGemini, fallbackFailure } from './failure.ts';
import { fallbackFlows, inferFlowsWithGemini } from './flows.ts';
import { geminiModel, hasGeminiKey } from './gemini.ts';
import { cloneRepo, listAllSourceFiles, listSourceFiles, makeTempDir, readSource, removeDir, type SourceFile } from './repo.ts';
import { auditHint, runTrAudit } from './trAudit.ts';
import { describeActions, healStep } from './heal.ts';
import { checkDependencies, restrictReport, runSecAudit } from './secAudit.ts';
import { VERIFY_FILE, verifyToken } from './verify.ts';
import { scanGitHistory, withHistory, HISTORY_DEPTH } from './gitHistory.ts';
import { reviewFindings } from './secReview.ts';
import { simpleGit } from 'simple-git';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  createHttpRunner,
  createPlaywrightRunner,
  fallbackPlan,
  generateAllPlans,
  writeSpecFile,
  type StepRunner,
  type TestPlan,
} from './runner.ts';
import type { Failure, Flow, Healing } from './types.ts';
import { AbortedError, errMsg, sleep, type ScanContext } from './util.ts';

const PRIORITY_TR = { critical: 'kritik', high: 'yüksek', medium: 'orta' } as const;

function repoName(url: string): string {
  return url.replace(/\.git$/, '').replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/^https?:\/\//, '') || url;
}

/** The real pipeline. Never throws (except AbortedError, which the caller swallows). */
export async function runRealScan(ctx: ScanContext): Promise<void> {
  const started = Date.now();
  const { log } = ctx;
  const checkAbort = () => {
    if (ctx.isAborted()) throw new AbortedError();
  };

  let repoDir: string | null = null;
  let runner: StepRunner | null = null;
  try {
    // ---------------- 1. clone ----------------
    let branch = 'main';
    let paths: string[] = [];
    log('info', `$ canary scan ${ctx.repoUrl}`);
    try {
      repoDir = await makeTempDir();
      log('info', `${repoName(ctx.repoUrl)} klonlanıyor (sığ kopya)…`);
      branch = await cloneRepo(ctx.repoUrl, repoDir);
      paths = await listSourceFiles(repoDir);
      log('success', `${repoName(ctx.repoUrl)}@${branch} klonlandı — ${paths.length} kaynak dosya seçildi`);
    } catch (e) {
      log('warn', `Klonlama başarısız (${errMsg(e)}). Kaynak kod olmadan devam ediliyor.`);
      if (repoDir) await removeDir(repoDir);
      repoDir = null;
    }
    checkAbort();

    ctx.emit({ type: 'scan_start', repo: repoName(ctx.repoUrl), branch, totalFiles: paths.length });

    // ---------------- 2. read files ----------------
    const files: SourceFile[] = [];
    for (const p of paths) {
      checkAbort();
      files.push({ path: p, content: repoDir ? await readSource(repoDir, p) : '' });
      ctx.emit({ type: 'file', path: p });
      await sleep(120);
    }

    // ---------------- 2b. Türkiye Uyum Tarayıcısı (static, no AI) ----------------
    let trHint = '';
    if (ctx.profile === 'tr' && repoDir) {
      try {
        log('info', '🇹🇷 Türkiye uyum taraması: tüm kaynak kodda İ/ı, ₺, UTC tarih ve KVKK riskleri aranıyor…');
        const allPaths = await listAllSourceFiles(repoDir);
        const known = new Map(files.map((f) => [f.path, f.content]));
        const all: SourceFile[] = [];
        for (const p of allPaths) all.push({ path: p, content: known.get(p) ?? (await readSource(repoDir, p)) });
        const indexHtml = await fsp.readFile(path.join(repoDir, 'index.html'), 'utf8').catch(() => null);
        const report = runTrAudit(all, indexHtml);
        ctx.emit({ type: 'tr_audit', report });
        const total = report.items.reduce((n, it) => n + it.count, 0);
        log(
          report.score >= 85 ? 'success' : 'warn',
          `🇹🇷 Türkiye uyum skoru ${report.score}/100 — ${report.filesScanned} dosyada ${report.items.length} risk türü, ${total} konum (yapay zeka kullanılmadı)`,
        );
        trHint = auditHint(report);
      } catch (e) {
        log('warn', `Türkiye uyum taraması yapılamadı (${errMsg(e)}).`);
      }
    }
    checkAbort();

    // ---------------- 2c. Güvenlik taraması (passive, static; only with authorization) ----------------
    if (ctx.security && repoDir) {
      try {
        log('info', '🛡️ Güvenlik taraması (pasif): yalnızca kaynak kod okunuyor, canlı sisteme istek/saldırı yapılmıyor…');
        const allPaths = await listAllSourceFiles(repoDir);
        const sources: SourceFile[] = [];
        for (const p of allPaths) sources.push({ path: p, content: await readSource(repoDir, p) });
        const tracked = (await simpleGit(repoDir).raw(['ls-files'])).split(/\r?\n/).filter(Boolean);
        let report = runSecAudit(sources, tracked);
        const lock = await fsp.readFile(path.join(repoDir, 'package-lock.json'), 'utf8').catch(() => null);
        report.dependencies = await checkDependencies(lock);
        const vulnDeps = report.dependencies?.length ?? 0;
        // AI second opinion: dismiss false alarms using the code around each finding (never sees secrets)
        if (hasGeminiKey() && report.items.some((it) => it.locations.length)) {
          try {
            log('ai', `${geminiModel()} bulguları çevresindeki koda bakarak gerçek mi yanlış alarm mı diye doğruluyor (gizli değerler maskelenip gönderilir)…`);
            report = await reviewFindings(report, sources);
            if (report.aiReview) {
              log('ai', `Yapay zeka incelemesi: ${report.aiReview.checked} bulgu bakıldı, ${report.aiReview.falsePositives} yanlış alarm ayıklandı.`);
            }
          } catch (e) {
            log('warn', `Yapay zeka doğrulaması yapılamadı (${errMsg(e)}); ham bulgular gösteriliyor.`);
          }
        }
        // git history (last N commits): secrets deleted from files but still readable in old commits
        try {
          log('info', `🛡️ Git geçmişi (son ${HISTORY_DEPTH} commit) silinmiş gizli anahtarlar için okunuyor (değerler gösterilmez)…`);
          const histItem = await scanGitHistory(repoDir, branch);
          report = withHistory(report, histItem);
          if (histItem) log('warn', `🛡️ Geçmişte ${histItem.count} silinmiş gizli anahtar bulundu — iptal edip yenileyin.`);
        } catch {
          /* history is optional */
        }
        if (!ctx.verified) {
          report = restrictReport(report, { file: VERIFY_FILE, content: `canary-verify=${await verifyToken(ctx.repoUrl)}` });
          log('info', `🛡️ Repo sahibi doğrulanmadı — kısıtlı rapor: dosya/satır/kod ve paket adları gizlendi (${VERIFY_FILE} ile açılır).`);
        }
        ctx.emit({ type: 'sec_audit', report });
        const total = report.items.reduce((n, it) => n + it.count, 0);
        log(
          report.score >= 85 && !vulnDeps ? 'success' : 'warn',
          `🛡️ Güvenlik skoru ${report.score}/100 — ${report.items.length} risk türü, ${total} konum, ${vulnDeps} açık bağımlılık (gizli değerler maskelendi)`,
        );
      } catch (e) {
        log('warn', `Güvenlik taraması yapılamadı (${errMsg(e)}).`);
      }
    }
    checkAbort();

    // ---------------- 3. infer flows ----------------
    let flows: Flow[] = [];
    if (hasGeminiKey() && files.length) {
      log('ai', `${geminiModel()} rotaları, sayfaları ve API dosyalarını okuyor; kritik kullanıcı akışları çıkarılıyor${ctx.profile === 'tr' ? ' (Türkiye profili: Türkçe karakter, ₺ ve TR format kontrolleri dahil)' : ''}…`);
      try {
        flows = await inferFlowsWithGemini(files, ctx.appUrl, ctx.profile, trHint);
        log('ai', `${flows.length} kullanıcı akışı bulundu${flows.some((f) => f.region === 'tr') ? ` (${flows.filter((f) => f.region === 'tr').length} tanesi Türkiye'ye özel)` : ''}; iş etkisine göre sıralandı.`);
      } catch (e) {
        log('warn', `Akış çıkarma başarısız (${errMsg(e)}). Dosya adlarından tahmin edilen akışlar kullanılıyor.`);
      }
    } else if (!hasGeminiKey()) {
      log('warn', 'GEMINI_API_KEY tanımlı değil — akışlar dosya adlarından tahmin ediliyor.');
    }
    if (flows.length === 0) flows = fallbackFlows(paths);
    checkAbort();

    for (const flow of flows) {
      checkAbort();
      ctx.emit({ type: 'flow', flow });
      log('info', `Akış [${PRIORITY_TR[flow.priority]}]${flow.region === 'tr' ? ' 🇹🇷' : ''} ${flow.name} — ${flow.steps.length} adım`);
      await sleep(250);
    }

    // ---------------- 4. start browser ----------------
    try {
      log('info', `Headless Chromium başlatılıyor${ctx.profile === 'tr' ? ' (dil: tr-TR, saat dilimi: Europe/Istanbul)' : ''}…`);
      runner = await createPlaywrightRunner(ctx.appUrl, ctx.profile);
      log('success', `Chromium hazır — ${ctx.appUrl} test ediliyor`);
    } catch (e) {
      log('warn', `Chromium başlatılamadı (${errMsg(e)}). Yalnızca HTTP kontrolleri yapılacak.`);
      runner = createHttpRunner(ctx.appUrl);
    }

    // ---------------- 5. write all tests in one Gemini call ----------------
    let aiPlans = new Map<string, TestPlan>();
    if (hasGeminiKey()) {
      try {
        log('ai', `${flows.length} akış için Playwright testleri yazılıyor…`);
        aiPlans = await generateAllPlans(flows, ctx.appUrl, files, ctx.profile);
        log('ai', `${aiPlans.size} test yazıldı.`);
      } catch (e) {
        log('warn', `Test üretimi başarısız (${errMsg(e)}). Basit sayfa açılış testleri kullanılıyor.`);
      }
    }
    checkAbort();

    // ---------------- 6. run each flow ----------------
    let passed = 0;
    let failed = 0;
    let healsLeft = 3; // each heal costs one AI request; keep the daily quota safe
    for (const flow of flows) {
      checkAbort();
      ctx.emit({ type: 'test_start', flowId: flow.id });
      const t0 = Date.now();

      const plan: TestPlan = aiPlans.get(flow.id) ?? fallbackPlan(flow);
      const spec = await writeSpecFile(flow, plan, ctx.appUrl);
      if (spec) log('info', `${spec} yazıldı`);
      checkAbort();

      try {
        await runner.newTest();
      } catch (e) {
        log('warn', `Tarayıcı bağlamı açılamadı (${errMsg(e)}). HTTP kontrollerine geçiliyor.`);
        await runner.close();
        runner = createHttpRunner(ctx.appUrl);
      }

      let failure: Failure | undefined;
      const healed: Healing[] = [];
      for (const step of flow.steps) {
        checkAbort();
        if (failure) {
          ctx.emit({ type: 'step', flowId: flow.id, stepId: step.id, status: 'skipped' });
          continue;
        }
        ctx.emit({ type: 'step', flowId: flow.id, stepId: step.id, status: 'running' });
        const stepStart = Date.now();
        try {
          await runner.runStep(step, plan.steps[step.id] ?? []);
          // Keep steps visible long enough for the audience to follow.
          const elapsed = Date.now() - stepStart;
          if (elapsed < 350) await sleep(350 - elapsed);
          ctx.emit({ type: 'step', flowId: flow.id, stepId: step.id, status: 'passed', ...(await runner.snapshot()) });
        } catch (e) {
          const error = errMsg(e);
          const shot = await runner.snapshot();
          ctx.emit({ type: 'step', flowId: flow.id, stepId: step.id, status: 'failed', ...shot });
          log('error', `✗ ${flow.name} › ${step.label}: ${error}`);

          // ---- self-healing: read the real page, rewrite the step, run it again ----
          let healNote = '';
          if (healsLeft > 0 && runner.mode === 'playwright' && hasGeminiKey()) {
            healsLeft--;
            const before = plan.steps[step.id] ?? [];
            try {
              log('ai', '🩹 Kendini onarma: Canary sayfanın gerçek halini okuyup bu adımı yeniden yazıyor…');
              const pageNow = await runner.pageSummary();
              const h = await healStep(flow, step, before, error, pageNow, ctx.profile);
              healNote = h.reason;
              if (h.healed) {
                ctx.emit({ type: 'step', flowId: flow.id, stepId: step.id, status: 'running' });
                await runner.runStep(step, h.actions);
                plan.steps[step.id] = h.actions;
                healed.push({ stepId: step.id, stepLabel: step.label, reason: h.reason, before: describeActions(before), after: describeActions(h.actions) });
                ctx.emit({ type: 'step', flowId: flow.id, stepId: step.id, status: 'passed', ...(await runner.snapshot()) });
                log('success', `🩹 Test kendini onardı: ${h.reason || step.label}`);
                continue;
              }
              log('warn', `🩹 Onarılamadı — sayfada bu adımı yapacak bir öğe yok${h.reason ? `: ${h.reason}` : ''}. Gerçek bir uygulama hatası olabilir.`);
            } catch (e2) {
              log('warn', `🩹 Onarma denemesi tamamlanamadı (${errMsg(e2)}).`);
            }
            ctx.emit({ type: 'step', flowId: flow.id, stepId: step.id, status: 'failed', ...(await runner.snapshot()) });
          }

          const note = healNote ? `${error} | Self-heal attempt: ${healNote}` : error;
          failure = await traceFailure(ctx, flow, step, note, files, repoDir, plan.steps[step.id] ?? []);
          failure = { ...failure, severity: flow.priority, flowName: flow.name, ...shot };
        }
      }

      if (healed.length) {
        const healedSpec = await writeSpecFile(flow, plan, ctx.appUrl);
        if (healedSpec) log('info', `Onarılan test kaydedildi: ${healedSpec}`);
      }
      const durationMs = Date.now() - t0;
      if (failure) {
        failed++;
        ctx.emit({ type: 'test_result', flowId: flow.id, status: 'failed', durationMs, failure, ...(healed.length ? { healed } : {}) });
      } else {
        passed++;
        log('success', `✓ ${flow.name} geçti (${(durationMs / 1000).toFixed(1)} sn)`);
        ctx.emit({ type: 'test_result', flowId: flow.id, status: 'passed', durationMs, ...(healed.length ? { healed } : {}) });
      }
    }

    // ---------------- 7. summary ----------------
    const covered = new Set(flows.flatMap((f) => f.files));
    const coverage = paths.length ? Math.round((covered.size / paths.length) * 100) : 0;
    log(failed ? 'warn' : 'success', `Bitti: ${flows.length} akıştan ${passed} geçti, ${failed} başarısız.`);
    ctx.emit({
      type: 'done',
      summary: { files: paths.length, flows: flows.length, passed, failed, coverage, durationMs: Date.now() - started },
    });
  } finally {
    if (runner) await runner.close().catch(() => {});
    if (repoDir) await removeDir(repoDir);
  }
}

async function traceFailure(
  ctx: ScanContext,
  flow: Flow,
  step: Flow['steps'][number],
  error: string,
  files: SourceFile[],
  repoDir: string | null,
  attempted: unknown[] = [],
): Promise<Failure> {
  if (hasGeminiKey() && files.length) {
    try {
      ctx.log('ai', `Hata kaynak koda kadar izleniyor: ${flow.name} › ${step.label}…`);
      const { failure, testIssue } = await analyzeWithGemini(flow, step, error, files, repoDir, attempted, ctx.profile);
      if (testIssue) {
        ctx.log('warn', `Uygulama kodu doğru görünüyor — sorun büyük ihtimalle Canary'nin kendi test adımında (${failure.file}:${failure.line}).`);
      } else {
        ctx.log('ai', `Kök neden: ${failure.file}:${failure.line} — ${failure.title}`);
      }
      return failure;
    } catch (e) {
      ctx.log('warn', `Kök neden analizi başarısız (${errMsg(e)}). En olası konum tahmin ediliyor.`);
    }
  }
  const f = await fallbackFailure(flow, step, error, files, repoDir);
  ctx.log('info', `Olası konum: ${f.file}:${f.line}`);
  return f;
}
