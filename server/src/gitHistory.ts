// Git geçmişi taraması — pasif: yalnızca klonlanmış kopyanın son N commit'ini OKUR.
// Amaç: dosyadan silinmiş ama geçmişte duran gizli anahtarları bulmak (silmek anahtarı iptal etmez).
//
// Gizlilik: bulunan değerin HİÇBİR parçası rapora/loga/AI'a girmez (ilk 4 karakter bile).
// Raporda yalnızca anahtar türü, dosya, satır ve kısa commit kimliği yer alır.

import { simpleGit } from 'simple-git';
import { SECRET_PATTERNS, scoreOf } from './secAudit.ts';
import type { SecAuditItem, SecAuditReport } from './types.ts';

export const HISTORY_DEPTH = 50;
const MAX_DIFF_CHARS = 20_000_000;
const MAX_FINDINGS = 50;
const MAX_LOCATIONS = 6;

const KIND: { re: RegExp; label: string }[] = [
  { re: /^AIza/, label: 'Google API anahtarı' },
  { re: /^AKIA/, label: 'AWS erişim anahtarı' },
  { re: /^gh[pousr]_/, label: 'GitHub token' },
  { re: /^sk-/, label: 'Gizli API anahtarı (sk-…)' },
  { re: /^xox[abprs]-/, label: 'Slack token' },
  { re: /^-----BEGIN/, label: 'Özel anahtar (PEM)' },
];

function kindOf(match: string): string {
  return KIND.find((k) => k.re.test(match))?.label ?? 'Gömülü parola / token';
}

export interface HistoryHit {
  /** the secret value itself — used only for the "still in HEAD?" check, NEVER reported */
  value: string;
  kind: string;
  file: string;
  line: number;
  commit: string;
}

/** Parse `git log -p` output; collect secret-looking values on ADDED lines. */
export function parseHistoryDiff(diff: string): HistoryHit[] {
  const hits: HistoryHit[] = [];
  let commit = '';
  let file = '';
  let line = 0;
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith('commit ') && /^commit [0-9a-f]{40}$/.test(raw)) { commit = raw.slice(7, 14); file = ''; continue; }
    if (raw.startsWith('+++ ')) { file = raw.startsWith('+++ b/') ? raw.slice(6) : ''; continue; }
    const h = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (h) { line = Number(h[1]); continue; }
    if (!file || !commit) continue;
    if (raw.startsWith('+')) {
      const text = raw.slice(1);
      const cur = line++;
      if (text.length > 500 || /(process\.env|import\.meta\.env|your[_-]?(key|api)|example|placeholder|xxx)/i.test(text)) continue;
      for (const p of SECRET_PATTERNS) {
        for (const m of text.matchAll(new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g'))) {
          const value = m[0].match(/['"]([^'"\s]{12,})['"]/)?.[1] ?? m[0];
          hits.push({ value, kind: kindOf(m[0]), file, line: cur, commit });
        }
      }
    } else if (!raw.startsWith('-')) {
      line++; // context line
    }
  }
  return hits;
}

/** Keep only secrets that are gone from HEAD (the ones still there are already reported by sec-secret). */
export async function removedFromHead(hits: HistoryHit[], stillInHead: (value: string) => Promise<boolean>): Promise<HistoryHit[]> {
  const seen = new Map<string, boolean>();
  const out: HistoryHit[] = [];
  for (const h of hits) {
    if (!seen.has(h.value)) {
      if (seen.size >= 200) break; // bound the work on noisy histories
      seen.set(h.value, await stillInHead(h.value));
    }
    if (seen.get(h.value) === false && !out.some((o) => o.value === h.value)) out.push(h);
    if (out.length >= MAX_FINDINGS) break;
  }
  return out;
}

export function historyItem(hits: HistoryHit[]): SecAuditItem | null {
  if (!hits.length) return null;
  return {
    id: 'sec-history-secret',
    severity: 'critical',
    title: 'Silinmiş ama git geçmişinde duran gizli anahtar',
    cwe: 'CWE-312',
    why: 'Anahtar dosyadan silinse bile eski commit\'lerde okunabilir; depoyu klonlayan herkes onu görebilir.',
    fix: 'Anahtarı hemen iptal edip yenileyin (silmek yetmez). İsterseniz git filter-repo ile geçmişten de temizleyin.',
    count: hits.length,
    locations: hits.slice(0, MAX_LOCATIONS).map((h) => ({
      file: h.file,
      line: h.line,
      text: `${h.kind} — commit ${h.commit} (değer gösterilmiyor)`,
    })),
  };
}

/** Add the history finding to a report and recompute the score. */
export function withHistory(report: SecAuditReport, item: SecAuditItem | null): SecAuditReport {
  if (!item) return report;
  const items = [item, ...report.items.filter((i) => i.id !== item.id)];
  const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  items.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
  return { ...report, items, score: scoreOf(items) };
}

/**
 * Fetch a bounded history (last HISTORY_DEPTH commits) and look for removed secrets.
 * Returns null when history is unavailable (offline, shallow-only, errors): the caller just skips.
 */
export async function scanGitHistory(repoDir: string, branch: string): Promise<SecAuditItem | null> {
  const git = simpleGit(repoDir, { timeout: { block: 60_000 } });
  try {
    await git.raw(['fetch', `--depth=${HISTORY_DEPTH}`, 'origin', branch]);
    let diff = await git.raw([
      'log', `-n`, String(HISTORY_DEPTH), '--no-color', '-p', '--no-ext-diff', '--format=commit %H',
      '--', '.', ':(exclude)package-lock.json', ':(exclude)*.lock', ':(exclude)*.min.js', ':(exclude)*.map',
    ]);
    if (diff.length > MAX_DIFF_CHARS) diff = diff.slice(0, MAX_DIFF_CHARS);
    const hits = parseHistoryDiff(diff);
    if (!hits.length) return null;
    const stillInHead = async (value: string) => {
      try {
        // exit 1 (no match) may not throw in simple-git, so decide by the output
        return (await git.raw(['grep', '-lF', '-e', value, 'HEAD'])).trim().length > 0;
      } catch {
        return true; // cannot tell: do not claim it was removed
      }
    };
    return historyItem(await removedFromHead(hits, stillInHead));
  } catch {
    return null;
  }
}
