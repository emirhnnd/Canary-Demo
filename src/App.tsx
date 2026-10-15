import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  ArrowRight, Bird, Check, ChevronRight, CircleDashed, FileCode2, FolderGit2, Globe, Loader2,
  Play, RotateCcw, ShieldCheck, Sparkles, TerminalSquare, X, AlertTriangle, MinusCircle, Zap,
} from 'lucide-react';
import type { Failure, Flow, FlowStatus, Healing, LogLevel, ScanEvent, StepStatus, Summary, TrAuditReport, SecAuditReport } from './types';
import { DEMO_APP_URL, DEMO_REPO } from './scenario';
import { runScan, usingBackend } from './engine';
import { MiniBrowser } from './components/MiniBrowser';
import { FailureModal } from './components/FailureModal';
import { ScoreRing, SEVERITY_TR, TrAuditModal, scoreGrade } from './components/TrAuditModal';
import { SecAuditModal } from './components/SecAuditModal';

const Github = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.9 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A11.5 11.5 0 0 0 23.5 12C23.5 5.7 18.3.5 12 .5z" />
  </svg>
);

interface LogLine { t: number; level: LogLevel; message: string }

interface State {
  repo: string;
  branch: string;
  totalFiles: number;
  files: string[];
  flows: Flow[];
  flowStatus: Record<string, FlowStatus>;
  stepStatus: Record<string, StepStatus>;
  durations: Record<string, number>;
  logs: LogLine[];
  current: { flowId: string; stepId: string } | null;
  /** latest real screenshot from the backend (live mode only) */
  shot: { img: string; url?: string } | null;
  /** Türkiye Uyum Tarayıcısı result (Canary TR) */
  audit: TrAuditReport | null;
  /** Güvenlik Tarayıcısı result (only when the user confirmed authorization) */
  secAudit: SecAuditReport | null;
  /** self-healed steps per flow */
  healed: Record<string, Healing[]>;
  failures: Failure[];
  summary: Summary | null;
  startedAt: number;
  /** ms since start when the last event arrived (drives the "still working" hint) */
  lastT: number;
}

const initial: State = {
  repo: '', branch: 'main', totalFiles: 0, files: [], flows: [], flowStatus: {}, stepStatus: {},
  durations: {}, logs: [], current: null, shot: null, audit: null, secAudit: null, healed: {}, failures: [], summary: null, startedAt: 0, lastT: 0,
};

type Action = { type: 'reset' } | { type: 'event'; e: ScanEvent };

function reducer(s: State, a: Action): State {
  if (a.type === 'reset') return { ...initial, startedAt: Date.now() };
  const t = Date.now() - s.startedAt;
  const next = apply({ ...s, lastT: t }, a.e, t);
  return next;
}

function apply(s: State, e: ScanEvent, t: number): State {
  switch (e.type) {
    case 'scan_start':
      return { ...s, repo: e.repo, branch: e.branch, totalFiles: e.totalFiles };
    case 'file':
      return { ...s, files: [...s.files, e.path] };
    case 'flow':
      return { ...s, flows: [...s.flows, e.flow], flowStatus: { ...s.flowStatus, [e.flow.id]: 'pending' } };
    case 'log':
      return { ...s, logs: [...s.logs, { t, level: e.level, message: e.message }] };
    case 'test_start':
      return { ...s, flowStatus: { ...s.flowStatus, [e.flowId]: 'running' } };
    case 'step':
      return {
        ...s,
        stepStatus: { ...s.stepStatus, [`${e.flowId}:${e.stepId}`]: e.status },
        current: e.status === 'skipped' ? s.current : { flowId: e.flowId, stepId: e.stepId },
        shot: e.screenshot ? { img: e.screenshot, url: e.pageUrl } : s.shot,
      };
    case 'test_result':
      return {
        ...s,
        flowStatus: { ...s.flowStatus, [e.flowId]: e.status },
        durations: { ...s.durations, [e.flowId]: e.durationMs },
        failures: e.failure ? [...s.failures, e.failure] : s.failures,
        healed: e.healed?.length ? { ...s.healed, [e.flowId]: e.healed } : s.healed,
      };
    case 'tr_audit':
      return { ...s, audit: e.report };
    case 'sec_audit':
      return { ...s, secAudit: e.report };
    case 'done':
      return { ...s, summary: e.summary };
  }
}

type Phase = 'landing' | 'running' | 'done';

const PRIORITY_TR = { critical: 'kritik', high: 'yüksek', medium: 'orta' } as const;

/* ------------------------- honest status helpers ------------------------- */

/** Backend warnings that mean the scan ran in a reduced mode. Shown as a banner, not only in the log. */
const DEGRADE_RULES: { re: RegExp; text: string }[] = [
  { re: /Backend unreachable|Backend'e ulaşılamadı/i, text: 'Canlı backend\'e ulaşılamadı — bu canlı bir tarama değil, kayıtlı demo çalıştırması' },
  { re: /Clone failed|Klonlama başarısız/i, text: 'Repo klonlanamadı — tarama kaynak kod olmadan yapıldı' },
  { re: /GEMINI_API_KEY (not set|tanımlı değil)|Flow inference failed|Akış çıkarma başarısız/i, text: 'Yapay zeka kullanılamadı — kullanıcı akışları dosya adlarından tahmin edildi' },
  { re: /Test generation failed|Test üretimi başarısız/i, text: 'Yapay zeka testleri yazamadı — yalnızca basit sayfa açılış kontrolleri yapıldı' },
  { re: /Root-cause analysis failed|Kök neden analizi başarısız/i, text: 'Yapay zeka kök neden analizi yapılamadı — hata konumları tahmini' },
  { re: /Chromium unavailable|Chromium başlatılamadı/i, text: 'Tarayıcı başlatılamadı — yalnızca HTTP kontrolleri yapıldı' },
];

function causeOf(msg: string): string {
  if (/GEMINI_API_KEY (not set|tanımlı değil)/i.test(msg)) return 'server/.env içinde Gemini API anahtarı yok';
  if (/\b429\b|quota|RESOURCE_EXHAUSTED/i.test(msg)) return 'Gemini günlük kotası doldu; her gün yenilenir';
  if (/\b503\b|high demand|UNAVAILABLE|overloaded/i.test(msg)) return 'Gemini şu an çok yoğun; birkaç dakika sonra tekrar deneyin';
  if (/timed out/i.test(msg)) return 'Gemini zamanında yanıt vermedi';
  return '';
}

function degradedReasons(logs: LogLine[]): { text: string; cause: string }[] {
  const out: { text: string; cause: string }[] = [];
  for (const l of logs) {
    if (l.level !== 'warn') continue;
    const rule = DEGRADE_RULES.find((r) => r.re.test(l.message));
    if (rule && !out.some((o) => o.text === rule.text)) out.push({ text: rule.text, cause: causeOf(l.message) });
  }
  return out;
}

/** Accepts https://github.com/o/r, github.com/o/r or o/r. */
function checkRepo(v: string): string | null {
  const s = v.trim();
  if (!s) return 'Canary\'nin okuyacağı GitHub reposunu girin.';
  if (/^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(s)) {
    return 'Bu bir uygulama adresi gibi görünüyor. Buraya GitHub reposunu yazın, örn. github.com/kullanici/uygulama.';
  }
  return null;
}

function normalizeAppUrl(v: string): string {
  const s = v.trim();
  if (!s) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return /^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(s) ? `http://${s}` : `https://${s}`;
}

function checkAppUrl(v: string): string | null {
  const s = v.trim();
  if (!s) return 'Uygulamanın çalıştığı adresi girin, örn. http://localhost:5175.';
  let u: URL;
  try {
    u = new URL(normalizeAppUrl(s));
  } catch {
    return 'Bu geçerli bir adres değil. Örnek: http://localhost:5175';
  }
  if (/(^|\.)github\.com$/i.test(u.hostname)) {
    return 'Bu repo linki. Buraya uygulamanın çalıştığı adresi yazın, örn. http://localhost:5175.';
  }
  return null;
}

export default function App() {
  const [phase, setPhase] = useState<Phase>('landing');
  const [repoInput, setRepoInput] = useState(DEMO_REPO);
  const [appInput, setAppInput] = useState(DEMO_APP_URL);
  const [trProfile, setTrProfile] = useState(true);
  const [state, dispatch] = useReducer(reducer, initial);
  const [modal, setModal] = useState<Failure | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [secOpen, setSecOpen] = useState(false);
  const [secScan, setSecScan] = useState(false);
  const [now, setNow] = useState(Date.now());
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (phase !== 'running') return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [phase]);

  const start = () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    dispatch({ type: 'reset' });
    setModal(null);
    setAuditOpen(false);
    setSecOpen(false);
    setPhase('running');
    runScan(repoInput.trim(), normalizeAppUrl(appInput), trProfile ? 'tr' : 'global', secScan, (e) => {
      dispatch({ type: 'event', e });
      if (e.type === 'done') setPhase('done');
    }, ac.signal).catch((err) => {
      if (err.name !== 'AbortError') console.error(err);
    });
  };

  // Auto-open the bug report shortly after the run finishes (demo moment).
  useEffect(() => {
    if (phase === 'done' && state.failures.length) {
      const t = setTimeout(() => setModal(state.failures[0]), 1200);
      return () => clearTimeout(t);
    }
  }, [phase, state.failures]);

  const backHome = () => {
    abortRef.current?.abort();
    setPhase('landing');
    setModal(null);
  };

  const reasons = useMemo(() => degradedReasons(state.logs), [state.logs]);

  if (phase === 'landing') {
    return (
      <Landing
        repo={repoInput} setRepo={setRepoInput}
        appUrl={appInput} setAppUrl={setAppInput}
        tr={trProfile} setTr={setTrProfile}
        sec={secScan} setSec={setSecScan}
        onStart={start}
      />
    );
  }

  return (
    <div className="app">
      <RunHeader state={state} phase={phase} now={now} degraded={reasons.length > 0} tr={trProfile} onRestart={start} onHome={backHome} />
      <Stepper state={state} phase={phase} />
      <StatusStrip state={state} phase={phase} now={now} reasons={reasons} />
      {state.audit && <TrAuditStrip report={state.audit} onOpen={() => setAuditOpen(true)} />}
      {state.secAudit && <SecAuditStrip report={state.secAudit} onOpen={() => setSecOpen(true)} />}
      <main className="run-grid">
        <FilePanel state={state} />
        <FlowPanel state={state} onOpenFailure={setModal} />
        <div className="right-col">
          <LivePreview state={state} phase={phase} appUrl={appInput} />
          <Terminal logs={state.logs} />
        </div>
      </main>
      {phase === 'done' && state.summary && (
        <SummaryBar summary={state.summary} failures={state.failures} degraded={reasons.length > 0} audit={state.audit} healedCount={Object.values(state.healed).reduce((n, h) => n + h.length, 0)} onOpen={() => setModal(state.failures[0])} />
      )}
      {modal && <FailureModal failure={modal} onClose={() => setModal(null)} />}
      {auditOpen && state.audit && <TrAuditModal report={state.audit} onClose={() => setAuditOpen(false)} />}
      {secOpen && state.secAudit && <SecAuditModal report={state.secAudit} onClose={() => setSecOpen(false)} />}
    </div>
  );
}

/* ---------------------------------- Landing ---------------------------------- */

function Landing(props: {
  repo: string; setRepo: (v: string) => void;
  appUrl: string; setAppUrl: (v: string) => void;
  tr: boolean; setTr: (v: boolean) => void;
  sec: boolean; setSec: (v: boolean) => void;
  onStart: () => void;
}) {
  const [tried, setTried] = useState(false);
  const repoErr = checkRepo(props.repo);
  const appErr = checkAppUrl(props.appUrl);
  const submit = () => {
    setTried(true);
    if (!repoErr && !appErr) props.onStart();
  };
  // Show a problem as soon as the user types something wrong, or after they try to run.
  const showRepo = repoErr && (tried || props.repo.trim() !== '');
  const showApp = appErr && (tried || props.appUrl.trim() !== '');
  return (
    <div className="landing">
      <div className="glow" />
      <nav className="land-nav">
        <Logo />
        <div className="nav-links">
          <span>Dokümanlar</span>
          <span>Fiyatlar</span>
          <span className="pill-yc">YC W26 · demo</span>
        </div>
      </nav>

      <section className="hero">
        <div className="eyebrow"><Sparkles size={13} /> Kodunuzu okuyan yapay zeka QA mühendisi · Türkiye için</div>
        <h1>
          Bozuk kullanıcı akışlarını<br />
          <span className="accent">müşterilerinizden önce yakalayın.</span>
        </h1>
        <p className="sub">
          Canary TR kaynak kodunuzu okuyup ne yapmak <i>istediğinizi</i> anlar, her kritik akış için uçtan uca
          testler üretir ve uygulamanızda çalıştırır — Türkçe karakterler, ₺ ve TR formatlarıyla birlikte.
        </p>

        <form className="run-card" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
          <label className={showRepo ? 'invalid' : ''} title="Canary'nin okuyacağı kod">
            <Github size={15} />
            <input
              value={props.repo}
              onChange={(e) => props.setRepo(e.target.value)}
              placeholder="github.com/org/repo"
              aria-label="GitHub reposu"
              aria-invalid={Boolean(showRepo)}
            />
          </label>
          <label className={showApp ? 'invalid' : ''} title="Uygulamanın çalıştığı adres">
            <Globe size={15} />
            <input
              value={props.appUrl}
              onChange={(e) => props.setAppUrl(e.target.value)}
              placeholder="http://localhost:5173"
              aria-label="Uygulama adresi"
              aria-invalid={Boolean(showApp)}
            />
          </label>
          <button className="btn primary big" type="submit">
            <Play size={16} fill="currentColor" /> Canary'yi çalıştır
          </button>
        </form>
        <div className="run-hints">
          <span><Github size={12} /> <b>Repo</b> — Canary'nin okuyacağı kod</span>
          <span><Globe size={12} /> <b>Uygulama adresi</b> — o uygulamanın çalıştığı yer (canlı site ya da localhost)</span>
        </div>
        <button
          type="button"
          className={`tr-toggle ${props.tr ? 'on' : ''}`}
          onClick={() => props.setTr(!props.tr)}
          aria-pressed={props.tr}
        >
          <span className="tr-switch"><span /></span>
          <span className="tr-flag" aria-hidden>🇹🇷</span>
          <b>Türkiye profili {props.tr ? 'açık' : 'kapalı'}</b>
          <span className="tr-desc">
            {props.tr
              ? 'Türkçe tarayıcı (tr-TR, İstanbul saati) · İ/ı, ₺ ve "1.249,90" biçimi · TC Kimlik, IBAN, +90, KVKK kontrolleri · Türkçe analiz'
              : 'Orijinal Canary davranışı: İngilizce tarayıcı ve genel kontroller'}
          </span>
        </button>
        <label className="sec-consent">
          <input type="checkbox" checked={props.sec} onChange={(e) => props.setSec(e.target.checked)} />
          <span>
            🛡️ <b>Güvenlik taraması</b> <i>(beta — geliştirme aşamasında)</i> ekle — yalnızca kaynak kodu okur (pasif), canlı sisteme saldırı/istek yapmaz.
            Bu kodun <b>sahibi olduğumu veya test etme iznim olduğunu</b> onaylıyorum.
          </span>
        </label>
        {(showRepo || showApp) && (
          <div className="run-errors" role="alert">
            {showRepo && <div><AlertTriangle size={13} /> {repoErr}</div>}
            {showApp && <div><AlertTriangle size={13} /> {appErr}</div>}
          </div>
        )}

        <div className="stats-row">
          <div><b>%90+</b><span>günler içinde akış kapsamı</span></div>
          <div><b>0</b><span>elle yazılan test</span></div>
          <div><b>🇹🇷</b><span>Türkçe karakter, ₺ ve TR format testleri</span></div>
        </div>
      </section>
      <footer className="land-foot">
        {usingBackend ? 'Canlı backend bağlı' : 'Demo modu'} · Canary TR demo
      </footer>
    </div>
  );
}

function Logo() {
  return (
    <div className="logo">
      <span className="logo-mark"><Bird size={16} /></span>
      Canary <span className="logo-sub">TR</span>
    </div>
  );
}

/* --------------------------------- Run view --------------------------------- */

function RunHeader({ state, phase, now, degraded, tr, onRestart, onHome }: {
  state: State; phase: Phase; now: number; degraded: boolean; tr: boolean; onRestart: () => void; onHome: () => void;
}) {
  const elapsed = phase === 'done' && state.summary ? state.summary.durationMs : now - state.startedAt;
  const passed = Object.values(state.flowStatus).filter((s) => s === 'passed').length;
  const failed = Object.values(state.flowStatus).filter((s) => s === 'failed').length;
  return (
    <header className="run-header">
      <button className="logo-btn" onClick={onHome}><Logo /></button>
      <div className="repo-pill">
        <FolderGit2 size={13} /> {state.repo || '…'} <span className="branch">{state.branch}</span>
      </div>
      {tr && <span className="tr-pill" title="Türkiye profili açık">🇹🇷 TR profili</span>}
      <div className={`status ${phase} ${phase === 'done' && !failed ? (degraded ? 'partial' : 'clean') : ''}`}>
        {phase === 'running' ? <Loader2 size={13} className="spin" /> : failed || degraded ? <AlertTriangle size={13} /> : <Check size={13} />}
        {phase === 'running'
          ? 'Çalışıyor'
          : failed
            ? `${failed} sorun bulundu`
            : degraded
              ? 'Kısmi tarama'
              : 'Tüm akışlar geçti'}
      </div>
      <div className="header-stats">
        <Stat label="dosya" value={`${state.files.length}/${state.totalFiles || '–'}`} />
        <Stat label="akış" value={state.flows.length} />
        <Stat label="geçti" value={passed} cls="ok" />
        <Stat label="başarısız" value={failed} cls={failed ? 'bad' : ''} />
        <Stat label="süre" value={`${(Math.max(0, elapsed) / 1000).toFixed(1)} sn`} />
      </div>
      <button className="btn ghost" onClick={onRestart}><RotateCcw size={14} /> Tekrar çalıştır</button>
    </header>
  );
}

function Stat({ label, value, cls = '' }: { label: string; value: string | number; cls?: string }) {
  return (
    <div className={`stat ${cls}`}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

/** Explains long AI waits while running, and reduced-mode scans at any time. */
function StatusStrip({ state, phase, now, reasons }: {
  state: State; phase: Phase; now: number; reasons: { text: string; cause: string }[];
}) {
  const quietMs = phase === 'running' ? now - state.startedAt - state.lastT : 0;
  const lastAi = [...state.logs].reverse().find((l) => l.level === 'ai');
  const waiting = phase === 'running' && quietMs > 5_000;
  if (!waiting && reasons.length === 0) return null;
  return (
    <div className="status-strip">
      {waiting && (
        <div className="wait-hint">
          <Loader2 size={13} className="spin" />
          <span>
            {lastAi ? lastAi.message.replace(/…$/, '') : 'Çalışıyor'} — {Math.floor(quietMs / 1000)} sn'dir bekleniyor.
            Yapay zeka adımları bir dakikayı bulabilir.
          </span>
        </div>
      )}
      {reasons.length > 0 && (
        <div className="degraded" role="status">
          <AlertTriangle size={14} />
          <div>
            <b>Kısmi tarama — sonuçlar eksik olabilir</b>
            {reasons.map((r) => (
              <span key={r.text}>
                {r.text}
                {r.cause && <em> ({r.cause})</em>}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Canary TR: Türkiye uyum skoru, always visible once the static scan is done. */
function TrAuditStrip({ report, onOpen }: { report: TrAuditReport; onOpen: () => void }) {
  const grade = scoreGrade(report.score);
  const bySev = (['critical', 'high', 'medium', 'low'] as const)
    .map((sv) => ({ sv, n: report.items.filter((it) => it.severity === sv).reduce((a, it) => a + it.count, 0) }))
    .filter((x) => x.n > 0);
  return (
    <div className="status-strip">
      <button className={`tr-strip ${grade.cls}`} onClick={onOpen}>
        <ScoreRing score={report.score} size={44} />
        <div className="tr-strip-text">
          <b>🇹🇷 Türkiye uyum skoru {report.score}/100 · {grade.label}</b>
          <span>
            {report.items.length
              ? bySev.map((x) => `${x.n} ${SEVERITY_TR[x.sv].toLocaleLowerCase('tr-TR')}`).join(' · ') + ' risk · ' + report.items.map((it) => it.title).slice(0, 2).join(' · ')
              : 'Türkiye\'ye özel risk bulunamadı'}
          </span>
        </div>
        <span className="tr-strip-cta">Raporu aç <ArrowRight size={13} /></span>
      </button>
    </div>
  );
}

/** Güvenlik skoru strip, shown once the (opt-in) passive security audit is done. */
function SecAuditStrip({ report, onOpen }: { report: SecAuditReport; onOpen: () => void }) {
  const grade = scoreGrade(report.score);
  const deps = report.dependencies?.length ?? report.dependencyCount ?? 0;
  return (
    <div className="status-strip">
      <button className={`tr-strip ${grade.cls}`} onClick={onOpen}>
        <ScoreRing score={report.score} size={44} />
        <div className="tr-strip-text">
          <b>🛡️ Güvenlik skoru {report.score}/100 · {grade.label} · beta</b>
          <span>
            {report.items.length || deps
              ? `${report.items.length} risk türü · ${deps} açık bağımlılık · ` + report.items.map((it) => it.title).slice(0, 2).join(' · ')
              : 'Bilinen bir güvenlik riski bulunamadı'}
          </span>
        </div>
        <span className="tr-strip-cta">Raporu aç <ArrowRight size={13} /></span>
      </button>
    </div>
  );
}

function Stepper({ state, phase }: { state: State; phase: Phase }) {
  const testsStarted = Object.values(state.flowStatus).some((s) => s !== 'pending');
  const steps = [
    { label: 'Repoyu klonla', done: state.files.length > 0 },
    { label: 'Kodu oku', done: state.totalFiles > 0 && state.files.length === state.totalFiles && state.flows.length > 0 },
    { label: 'Akışları çıkar', done: testsStarted },
    { label: 'E2E testleri çalıştır', done: phase === 'done' },
    { label: 'Rapor', done: phase === 'done' },
  ];
  const activeIdx = steps.findIndex((s) => !s.done);
  return (
    <div className="stepper">
      {steps.map((s, i) => (
        <div key={s.label} className={`st ${s.done ? 'done' : i === activeIdx ? 'active' : ''}`}>
          <span className="st-dot">{s.done ? <Check size={11} /> : i + 1}</span>
          {s.label}
          {i < steps.length - 1 && <ChevronRight size={14} className="st-sep" />}
        </div>
      ))}
    </div>
  );
}

function FilePanel({ state }: { state: State }) {
  const pct = state.totalFiles ? Math.round((state.files.length / state.totalFiles) * 100) : 0;
  const flowFiles = useMemo(() => {
    const m = new Map<string, FlowStatus>();
    for (const f of state.flows) for (const file of f.files) {
      const st = state.flowStatus[f.id];
      if (m.get(file) !== 'failed') m.set(file, st);
    }
    return m;
  }, [state.flows, state.flowStatus]);
  const bugFile = state.failures[0]?.file;
  const trFiles = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of state.audit?.items ?? []) for (const l of it.locations) m.set(l.file, (m.get(l.file) ?? 0) + 1);
    return m;
  }, [state.audit]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [state.files.length]);

  return (
    <section className="panel files">
      <div className="panel-head">
        <FileCode2 size={14} /> Kod tabanı
        <span className="muted right">{pct}%</span>
      </div>
      <div className="progress"><div style={{ width: `${pct}%` }} /></div>
      <div className="file-list" ref={listRef}>
        {state.files.map((f, i) => {
          const st = flowFiles.get(f);
          const isLatest = i === state.files.length - 1 && state.files.length < state.totalFiles;
          return (
            <div key={f} className={`file ${isLatest ? 'reading' : ''} ${f === bugFile ? 'bug' : ''}`}>
              <span className={`fdot ${st ?? ''}`} />
              <span className="fname">{f}</span>
              {trFiles.has(f) && f !== bugFile && <span className="tr-fbadge" title="Türkiye uyum riski">🇹🇷 {trFiles.get(f)}</span>}
              {f === bugFile && <span className="fbadge">hata</span>}
            </div>
          );
        })}
        {state.files.length === 0 && <div className="empty"><Loader2 size={14} className="spin" /> Klonlanıyor…</div>}
      </div>
    </section>
  );
}

function FlowPanel({ state, onOpenFailure }: { state: State; onOpenFailure: (f: Failure) => void }) {
  return (
    <section className="panel flows">
      <div className="panel-head">
        <Zap size={14} /> Kullanıcı akışları <span className="muted">koddan çıkarıldı</span>
        <span className="muted right">{state.flows.length} bulundu</span>
      </div>
      <div className="flow-list">
        {state.flows.length === 0 && (
          <div className="empty big">
            <Sparkles size={18} className="spin-slow" />
            Kullanıcıların ne yaptığını anlamak için rotalar, formlar ve API dosyaları okunuyor…
          </div>
        )}
        {state.flows.map((f) => {
          const st = state.flowStatus[f.id];
          const failure = state.failures.find((x) => x.flowId === f.id);
          const open = st === 'running' || st === 'failed';
          return (
            <div key={f.id} className={`flow ${st}`}>
              <div className="flow-top">
                <FlowIcon status={st} />
                <div className="flow-title">
                  <b>{f.name}</b>
                  <span>{f.description}</span>
                </div>
                {state.healed[f.id] && <span className="heal-badge" title="Test kendini onardı">🩹 onarıldı</span>}
                {f.region === 'tr' && <span className="tr-badge" title="Türkiye'ye özel kontrol">🇹🇷 TR</span>}
                <span className={`prio ${f.priority}`}>{PRIORITY_TR[f.priority]}</span>
                {state.durations[f.id] !== undefined && (
                  <span className="dur">{(state.durations[f.id] / 1000).toFixed(1)} sn</span>
                )}
              </div>
              {open && (
                <div className="steps">
                  {f.steps.map((s) => {
                    const ss = state.stepStatus[`${f.id}:${s.id}`] ?? 'pending';
                    return (
                      <div key={s.id} className={`step ${ss}`}>
                        <StepIcon status={ss} />
                        <span>{s.label}</span>
                        <code>{s.url}</code>
                      </div>
                    );
                  })}
                </div>
              )}
              {state.healed[f.id]?.map((h) => (
                <div key={h.stepId} className="heal-note">
                  <b>🩹 Test kendini onardı</b> — {h.reason}
                  <div className="heal-diff">
                    <code className="del">− {h.before}</code>
                    <code className="add">+ {h.after}</code>
                  </div>
                </div>
              ))}
              {failure && (
                <button className="fail-cta" onClick={() => onOpenFailure(failure)}>
                  <AlertTriangle size={13} /> {failure.title}
                  <span className="right">{failure.kind === 'test_issue' ? 'Ayrıntıları gör' : 'Kök nedeni gör'} <ArrowRight size={13} /></span>
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function FlowIcon({ status }: { status: FlowStatus }) {
  if (status === 'running') return <Loader2 size={16} className="spin ic run" />;
  if (status === 'passed') return <span className="ic-badge ok"><Check size={12} /></span>;
  if (status === 'failed') return <span className="ic-badge bad"><X size={12} /></span>;
  return <CircleDashed size={16} className="ic muted" />;
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === 'running') return <Loader2 size={12} className="spin run" />;
  if (status === 'passed') return <Check size={12} className="ok" />;
  if (status === 'failed') return <X size={12} className="bad" />;
  if (status === 'skipped') return <MinusCircle size={12} className="muted" />;
  return <CircleDashed size={12} className="muted" />;
}

function hostOf(u: string): string | undefined {
  try {
    return new URL(/^https?:\/\//i.test(u) ? u : `http://${u}`).host || undefined;
  } catch {
    return undefined;
  }
}

function LivePreview({ state, phase, appUrl }: { state: State; phase: Phase; appUrl: string }) {
  const cur = state.current;
  const flow = cur ? state.flows.find((f) => f.id === cur.flowId) : undefined;
  const step = flow?.steps.find((s) => s.id === cur?.stepId);
  const st = cur ? state.stepStatus[`${cur.flowId}:${cur.stepId}`] : undefined;
  return (
    <section className="panel preview">
      <div className="panel-head">
        <Globe size={14} /> Canlı tarayıcı
        {flow && phase === 'running' && <span className="muted right">{flow.name}</span>}
      </div>
      <MiniBrowser
        url={step?.url ?? '/'}
        view={step?.view ?? null}
        target={step?.target}
        failed={st === 'failed'}
        idle={!step}
        shot={state.shot?.img}
        pageUrl={state.shot?.url}
        host={hostOf(appUrl)}
      />
      {step && (
        <div className={`now-doing ${st}`}>
          <StepIcon status={st ?? 'pending'} /> {step.label}
        </div>
      )}
    </section>
  );
}

function Terminal({ logs }: { logs: LogLine[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [logs.length]);
  return (
    <section className="panel term">
      <div className="panel-head"><TerminalSquare size={14} /> Ajan kaydı</div>
      <div className="term-body" ref={ref}>
        {logs.map((l, i) => (
          <div key={i} className={`log ${l.level}`}>
            <span className="lt">{(l.t / 1000).toFixed(1).padStart(5, ' ')}s</span>
            {l.level === 'ai' && <Sparkles size={11} className="ai-ic" />}
            <span>{l.message}</span>
          </div>
        ))}
        <div className="cursor">▍</div>
      </div>
    </section>
  );
}

function SummaryBar({ summary, failures, degraded, audit, healedCount, onOpen }: {
  summary: Summary; failures: Failure[]; degraded: boolean; audit: TrAuditReport | null; healedCount: number; onOpen: () => void;
}) {
  const bugs = failures.filter((f) => f.kind !== 'test_issue');
  const testIssues = failures.length - bugs.length;
  const title = bugs.length
    ? `Canary ${bugs.length} hatanın canlıya çıkmasını engelledi`
    : testIssues
      ? `Uygulamada hata bulunmadı — ${testIssues} testin yeniden yazılması gerekiyor`
      : degraded
        ? 'Tarama kısmi modda bitti — güvenli demek için yeterli kanıt yok'
        : 'Tüm kritik akışlar geçti — birleştirmek güvenli';
  return (
    <div className={`summary ${bugs.length ? 'has-bug' : testIssues || degraded ? 'has-warn' : ''}`}>
      <ShieldCheck size={18} />
      <div>
        <b>{title}</b>
        <span>
          {summary.flows} akış · {summary.passed} geçti · {summary.failed} başarısız · %{summary.coverage} akış kapsamı ·{' '}
          {(summary.durationMs / 1000).toFixed(1)} sn · elle yazılan test: 0
          {healedCount ? ` · 🩹 ${healedCount} test kendini onardı` : ''}
          {audit ? ` · 🇹🇷 Türkiye uyum skoru ${audit.score}/100` : ''}
        </span>
      </div>
      {failures.length > 0 && (
        <button className="btn primary" onClick={onOpen}>
          {bugs.length ? 'Hata raporunu gör' : 'Ayrıntıları gör'} <ArrowRight size={14} />
        </button>
      )}
    </div>
  );
}
