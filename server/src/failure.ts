import { askJson } from './gemini.ts';
import { lastCommit, type SourceFile } from './repo.ts';
import type { CodeLine, Failure, Flow, FlowStep, Profile } from './types.ts';
import { outputLanguage } from './profile.ts';

interface RootCause {
  verdict?: 'app_bug' | 'test_issue';
  file?: string;
  line?: number;
  title?: string;
  expected?: string;
  actual?: string;
  explanation?: string;
  fix?: { before?: string; after?: string };
}

/**
 * File with line numbers, capped at `maxChars`. If we have to cut it, say so
 * explicitly — otherwise the model sees an abrupt end and "diagnoses" a
 * truncated file (e.g. "missing export default") that isn't really broken.
 */
function numbered(content: string, maxChars: number): string {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const row = `${String(i + 1).padStart(4)} | ${lines[i]}`;
    if (used + row.length > maxChars && out.length > 0) {
      out.push(`     … [NOT SHOWN: lines ${i + 1}-${lines.length} of ${lines.length}. The file continues; it is NOT truncated or incomplete.]`);
      break;
    }
    out.push(row);
    used += row.length + 1;
  }
  return out.join('\n');
}

/** ~10 lines around `line`, with the bad line flagged. Built from the real file, not from the LLM. */
export function snippet(content: string, line: number, before = 5, after = 4): CodeLine[] {
  const lines = content.split(/\r?\n/);
  const target = Math.min(Math.max(1, line), Math.max(1, lines.length));
  const start = Math.max(1, target - before);
  const end = Math.min(lines.length, target + after);
  const out: CodeLine[] = [];
  for (let n = start; n <= end; n++) {
    out.push({ n, text: lines[n - 1] ?? '', ...(n === target ? { bad: true } : {}) });
  }
  return out;
}

export async function analyzeWithGemini(
  flow: Flow,
  step: FlowStep,
  error: string,
  files: SourceFile[],
  repoDir: string | null,
  attempted: unknown[] = [],
  profile: Profile = 'tr',
): Promise<{ failure: Failure; testIssue: boolean }> {
  const candidates = files.filter((f) => flow.files.includes(f.path));
  const pool = (candidates.length ? candidates : files.slice(0, 6)).slice(0, 6);
  // ~150k characters in total, shared between the files (plenty for whole files in most apps).
  const perFile = Math.floor(150_000 / Math.max(1, pool.length));
  const sources = pool
    .map((f) => `=== FILE: ${f.path} (${f.content.split(/\r?\n/).length} lines) ===\n${numbered(f.content, perFile)}`)
    .join('\n\n');

  const prompt = `You are Canary, an AI QA engineer. An end-to-end test that YOU generated just failed.
First decide honestly whether the APP is broken or YOUR TEST is wrong.

Flow: ${flow.name} — ${flow.description}
Failed step: "${step.label}" (url ${step.url}${step.target ? `, target: ${step.target}` : ''})
Playwright actions the test ran for this step: ${JSON.stringify(attempted)}
Test error: ${error}

Source files (line numbers on the left). Parts marked NOT SHOWN exist in the real file but were
omitted for length — never conclude a file is truncated, incomplete or missing an export because of that.
${sources}

How to decide:
- "app_bug": you can point to a specific line whose logic is wrong and explains the error
  (crash, wrong value, missing handler, wrong route, disabled control that should be enabled...).
- "test_issue": the code looks correct and the failure comes from the test itself — a selector that
  doesn't match the real markup, text that differs from what is rendered, an element that appears
  only after an animation/timer/random state, a click on a non-interactive wrapper, a selector syntax error.
Do NOT invent a bug. If the code you were shown handles the step correctly, answer "test_issue".

${profile === 'tr' ? 'The browser ran with locale tr-TR and time zone Europe/Istanbul. Turkish-locale bugs (İ/ı case mapping, "1.249,90" number parsing, ₺ formatting, DD.MM.YYYY dates) count as real app bugs.\n' : ''}${outputLanguage(profile)}

Return JSON:
{
  "verdict": "app_bug" | "test_issue",
  "file": string,        // exact path of one file above (for test_issue: where the target element is rendered)
  "line": number,        // 1-based line: the buggy line, or (test_issue) the line rendering the target element
  "title": string,       // short title, max 8 words. e.g. "Place order button never re-enables"
  "expected": string,    // one sentence: what should have happened
  "actual": string,      // one sentence: what actually happened
  "explanation": string, // max 3 short sentences (under 60 words), plain language, no hedging or back-and-forth
  "fix": { "before": string, "after": string }  // app_bug only: the buggy line verbatim and the corrected single line
}`;

  const rc = await askJson<RootCause>(prompt, 40_000);
  const file = pool.find((f) => f.path === rc.file) ?? pool[0];
  if (!file) throw new Error('no source file available for root-cause analysis');

  const totalLines = file.content.split(/\r?\n/).length;
  let line = Number.isFinite(rc.line) ? Math.round(rc.line!) : 1;
  // If Gemini's line is off but the "before" text exists, snap to it.
  const before = rc.fix?.before?.trim();
  if (before) {
    const idx = file.content.split(/\r?\n/).findIndex((l) => l.trim() === before);
    if (idx >= 0) line = idx + 1;
  }
  line = Math.min(Math.max(1, line), totalLines);
  const actualLine = file.content.split(/\r?\n/)[line - 1]?.trim() ?? '';

  const testIssue = rc.verdict === 'test_issue';
  const failure: Failure = {
    flowId: flow.id,
    stepId: step.id,
    kind: testIssue ? 'test_issue' : 'app_bug',
    title: testIssue
      ? `Test sorunu: ${rc.title || `"${step.label}" adımı tamamlanamadı`}`
      : rc.title || `"${step.label}" adımı başarısız`,
    expected: rc.expected || `"${step.label}" adımı başarıyla tamamlanır`,
    actual: rc.actual || error,
    file: file.path,
    line,
    code: snippet(file.content, line),
    explanation: testIssue
      ? `${shorten(rc.explanation || 'Uygulama kodu doğru görünüyor; üretilen test bu öğeyle etkileşemedi.', 340)} Uygulamada değişiklik gerekmiyor — Canary bu adımı yeniden yazacak.`
      : shorten(rc.explanation || `Test şu hatayla başarısız oldu: ${error}`),
    commit: await lastCommit(repoDir, file.path),
    fix: testIssue
      ? { before: '// uygulamada değişiklik gerekmiyor', after: '// Canary bu test adımını yeniden yazar' }
      : { before: before || actualLine, after: rc.fix?.after?.trim() || actualLine },
  };
  return { failure, testIssue };
}

/** Keep explanations readable on stage: at most ~450 characters, cut at a sentence end. */
function shorten(text: string, max = 450): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = cut.lastIndexOf('. ');
  return end > 120 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

/** Deterministic root-cause guess when Gemini is unavailable. */
export async function fallbackFailure(
  flow: Flow,
  step: FlowStep,
  error: string,
  files: SourceFile[],
  repoDir: string | null,
): Promise<Failure> {
  const file = files.find((f) => flow.files.includes(f.path)) ?? files[0];
  if (!file) {
    return {
      flowId: flow.id,
      stepId: step.id,
      title: `"${step.label}" adımı başarısız`,
      expected: `"${step.label}" adımı başarıyla tamamlanır`,
      actual: error,
      file: flow.files[0] ?? 'unknown',
      line: 1,
      code: [{ n: 1, text: '// kaynak kod alınamadı', bad: true }],
      explanation: `Adım şu hatayla başarısız oldu: ${error}. Kaynak kod alınamadığı için daha ileri izlenemedi.`,
      commit: await lastCommit(null, ''),
      fix: { before: '', after: '' },
    };
  }

  const lines = file.content.split(/\r?\n/);
  const words = [step.target, step.label, step.url]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);
  let idx = lines.findIndex((l) => words.some((w) => l.toLowerCase().includes(w)) && /(on[A-Z]\w+|fetch|await|submit|disabled|navigate|href|to=)/.test(l));
  if (idx < 0) idx = lines.findIndex((l) => /(onSubmit|onClick|fetch\(|await |navigate\()/.test(l));
  if (idx < 0) {
    const nonBlank = lines.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
    idx = nonBlank.length ? nonBlank[Math.floor(nonBlank.length / 2)] : 0;
  }
  const line = idx + 1;
  const text = lines[idx]?.trim() ?? '';

  return {
    flowId: flow.id,
    stepId: step.id,
    title: `"${step.label}" adımı başarısız`,
    expected: `"${step.label}" adımı başarıyla tamamlanır`,
    actual: error,
    file: file.path,
    line,
    code: snippet(file.content, line),
    explanation: `"${step.label}" adımı başarısız oldu (${error}). Yapay zeka analizi yapılamadığı için bu, ${file.path} içinde bu etkileşimi yöneten en olası satır; mantığını ve çizdiği öğeyi kontrol edin.`,
    commit: await lastCommit(repoDir, file.path),
    fix: { before: text, after: text },
  };
}
