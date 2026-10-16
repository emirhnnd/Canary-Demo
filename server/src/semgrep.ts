// İsteğe bağlı Semgrep entegrasyonu — pasif statik analiz, ZORUNLU DEĞİL.
// Semgrep kurulu değilse (ya da çalışmazsa) sessizce atlanır; tarama onsuz da tamamlanır.
// Yalnızca klonlanmış kaynağı okur; telemetri kapalı (--metrics=off).

import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { maskSecrets, scoreOf } from './secAudit.ts';
import type { SecAuditItem, SecAuditReport, TrSeverity } from './types.ts';

const MAX_LOCATIONS = 6;
const MAX_ITEMS = 30;

interface SemgrepResult {
  check_id?: string;
  path?: string;
  start?: { line?: number };
  extra?: { message?: string; severity?: string; metadata?: { cwe?: string | string[] } };
}

const SEVERITY: Record<string, TrSeverity> = { ERROR: 'high', WARNING: 'medium', INFO: 'low' };

function cweOf(r: SemgrepResult): string {
  const raw = r.extra?.metadata?.cwe;
  const first = Array.isArray(raw) ? raw[0] : raw;
  return first?.match(/CWE-\d+/i)?.[0].toUpperCase() ?? 'CWE-?';
}

/**
 * Turn Semgrep's JSON output into report items (one per rule). The code line is read from the
 * clone and masked here: Semgrep's own `lines` field is never used.
 */
export function parseSemgrep(json: string, readLine: (file: string, line: number) => string): SecAuditItem[] {
  let results: SemgrepResult[] = [];
  try {
    results = (JSON.parse(json) as { results?: SemgrepResult[] }).results ?? [];
  } catch {
    return [];
  }
  const byRule = new Map<string, SecAuditItem>();
  for (const r of results) {
    if (!r.check_id || !r.path || !r.start?.line) continue;
    const id = `semgrep:${r.check_id.split('.').pop()}`;
    let item = byRule.get(id);
    if (!item) {
      if (byRule.size >= MAX_ITEMS) continue;
      item = {
        id,
        severity: SEVERITY[(r.extra?.severity ?? '').toUpperCase()] ?? 'low',
        title: `Semgrep: ${r.check_id.split('.').pop()!.replace(/[-_]/g, ' ')}`,
        cwe: cweOf(r),
        why: (r.extra?.message ?? 'Semgrep kuralı bu kalıbı riskli buldu.').slice(0, 300),
        fix: 'Semgrep kuralının açıklamasına bakın; girdiyi doğrulayıp güvenli bir API kullanın.',
        count: 0,
        locations: [],
      };
      byRule.set(id, item);
    }
    item.count++;
    if (item.locations.length < MAX_LOCATIONS) {
      item.locations.push({ file: r.path, line: r.start.line, text: maskSecrets(readLine(r.path, r.start.line)).trim().slice(0, 160) });
    }
  }
  return [...byRule.values()];
}

/** Add Semgrep items, skipping locations our own rules already reported; recompute the score. */
export function mergeSemgrep(report: SecAuditReport, extra: SecAuditItem[]): SecAuditReport {
  if (!extra.length) return report;
  const known = new Set(report.items.flatMap((i) => i.locations.map((l) => `${l.file}:${l.line}`)));
  const fresh = extra
    .map((it) => {
      const locations = it.locations.filter((l) => !known.has(`${l.file}:${l.line}`));
      const dup = it.locations.length - locations.length;
      return { ...it, locations, count: Math.max(0, it.count - dup) };
    })
    .filter((it) => it.count > 0);
  if (!fresh.length) return report;
  const items = [...report.items, ...fresh];
  const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  items.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
  return { ...report, items, score: scoreOf(items) };
}

/**
 * Run Semgrep when it is installed. Returns null when it is missing, fails or times out —
 * the caller just carries on. Note: `--config auto` downloads rules, so it needs network.
 */
export async function runSemgrep(repoDir: string, bin = 'semgrep'): Promise<SecAuditItem[] | null> {
  const stdout = await new Promise<string | null>((resolve) => {
    execFile(
      bin,
      ['scan', '--json', '--quiet', '--metrics=off', '--config', 'auto', '--timeout', '20', '--max-target-bytes', '500000', repoDir],
      { timeout: 180_000, maxBuffer: 30 * 1024 * 1024, cwd: repoDir },
      (err, out) => resolve(err && !out ? null : out || null),
    );
  });
  if (!stdout) return null;
  const cache = new Map<string, string[]>();
  const readLine = (file: string, line: number) => {
    // synchronous cache filled lazily is not possible with async fs: preload below
    return cache.get(file)?.[line - 1] ?? '';
  };
  try {
    const results = (JSON.parse(stdout) as { results?: SemgrepResult[] }).results ?? [];
    const files = [...new Set(results.map((r) => r.path).filter((p): p is string => !!p))].slice(0, 500);
    for (const f of files) {
      const abs = path.resolve(repoDir, f);
      if (!abs.startsWith(path.resolve(repoDir) + path.sep)) continue; // never read outside the clone
      cache.set(f, (await fsp.readFile(abs, 'utf8').catch(() => '')).split(/\r?\n/));
    }
  } catch {
    return null;
  }
  return parseSemgrep(stdout, readLine);
}
