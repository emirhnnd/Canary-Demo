import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { relativeTime } from './util.ts';
import type { Failure } from './types.ts';

const SOURCE_EXT = /\.(tsx?|jsx?)$/i;
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  'coverage', 'vendor', '.turbo', '.cache', 'public', 'storybook-static', '.vercel',
]);
const SKIP_FILE = /(\.d\.ts$|\.(test|spec|stories)\.[jt]sx?$|\.config\.[cm]?[jt]s$|\.min\.js$)/i;

export const MAX_FILES = 40;

export interface SourceFile {
  path: string; // repo-relative, forward slashes
  content: string;
}

export async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'canary-'));
}

export async function removeDir(dir: string): Promise<void> {
  // Windows sometimes holds locks on .git pack files for a moment; retry.
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}

/**
 * Make what people type cloneable: "github.com/o/r" and "o/r" become
 * "https://github.com/o/r". Full URLs, SSH and file:// are left as they are.
 */
export function normalizeRepoUrl(input: string): string {
  const s = input.trim().replace(/\/+$/, '');
  if (/^(https?|ssh|git|file):\/\//i.test(s) || /^git@/i.test(s)) return s;
  if (/^(www\.)?github\.com\//i.test(s)) return `https://${s.replace(/^www\./i, '')}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return `https://github.com/${s}`;
  return s;
}

export async function cloneRepo(repoUrl: string, dir: string): Promise<string> {
  const git = simpleGit({ timeout: { block: 90_000 } });
  await git.clone(repoUrl, dir, ['--depth', '1', '--single-branch']);
  try {
    const branch = await simpleGit(dir).revparse(['--abbrev-ref', 'HEAD']);
    return branch.trim() || 'main';
  } catch {
    return 'main';
  }
}

/** Higher score = more likely to describe user-facing flows. */
function scorePath(p: string): number {
  const s = p.toLowerCase();
  let score = 0;
  if (/(^|\/)(src|app|pages|routes|views|screens|features)\//.test(s)) score += 3;
  if (/(page|route|router|layout|view|screen)/.test(s)) score += 4;
  if (/(login|signin|signup|register|auth|checkout|cart|payment|order|search|product|account|reset|password)/.test(s)) score += 5;
  if (/(^|\/)(api|server|handlers?|controllers?)\//.test(s)) score += 3;
  if (/(^|\/)(app|main|index)\.[jt]sx?$/.test(s)) score += 2;
  if (/(util|helper|constant|types?|hooks?|styles?|theme|icons?|assets?)/.test(s)) score -= 2;
  return score;
}

export async function listSourceFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string) {
    if (found.length > 3000) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full);
      } else if (SOURCE_EXT.test(e.name) && !SKIP_FILE.test(e.name)) {
        found.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  }
  await walk(root);
  return found
    .map((p) => ({ p, s: scorePath(p) }))
    .sort((a, b) => b.s - a.s || a.p.localeCompare(b.p))
    .slice(0, MAX_FILES)
    .map((x) => x.p)
    .sort();
}

/** Every source file (not just the 40 picked for the AI) — for the static Türkiye scan. */
export async function listAllSourceFiles(root: string, max = 800): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string) {
    if (found.length >= max) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= max) return;
      if (e.name.startsWith('.') && e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full);
      } else if (SOURCE_EXT.test(e.name) && !/(\.d\.ts$|\.min\.js$)/i.test(e.name)) {
        found.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  }
  await walk(root);
  return found.sort();
}

export async function readSource(root: string, rel: string): Promise<string> {
  try {
    const content = await fs.readFile(path.join(root, rel), 'utf8');
    return content.length > 200_000 ? content.slice(0, 200_000) : content;
  } catch {
    return '';
  }
}

export async function lastCommit(root: string | null, file: string): Promise<Failure['commit']> {
  const fallback = { sha: '0000000', message: 'Latest change', author: 'unknown', when: 'recently' };
  if (!root) return fallback;
  try {
    const log = await simpleGit(root).log({ file, maxCount: 1 });
    const c = log.latest;
    if (!c) return fallback;
    return {
      sha: c.hash.slice(0, 7),
      message: c.message,
      author: c.author_name,
      when: relativeTime(new Date(c.date)),
    };
  } catch {
    return fallback;
  }
}
