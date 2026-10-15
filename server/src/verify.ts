import { createHash, createHmac, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Ownership verification + minimal audit log for the security audit.
//
// Verification: the repo owner proves control by committing a file `.canary-verify` that
// contains `canary-verify=<token>` to the repo root. The token is an HMAC of the repo path
// with a server secret, so it can't be guessed for a repo whose owner never opted in.
// Unverified repos only get a restricted report (no file names, lines, code or package names).
//
// Audit log: who scanned what and when — but no code and no raw IP (salted hash only),
// kept 30 days, because an IP address is personal data (KVKK / GDPR).

export const VERIFY_FILE = '.canary-verify';
const DIR = path.resolve(process.cwd());
const SECRET_FILE = path.join(DIR, '.canary-secret');
const LOG_DIR = path.join(DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'audit.jsonl');
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

let secret: string | null = null;

async function getSecret(): Promise<string> {
  if (secret) return secret;
  if (process.env.VERIFY_SECRET?.trim()) return (secret = process.env.VERIFY_SECRET.trim());
  try {
    secret = (await fs.readFile(SECRET_FILE, 'utf8')).trim();
    if (secret) return secret;
  } catch {
    /* create below */
  }
  secret = randomBytes(32).toString('hex');
  await fs.writeFile(SECRET_FILE, secret, { encoding: 'utf8', mode: 0o600 }).catch(() => {});
  return secret;
}

/** "https://github.com/Owner/Repo" -> "owner/repo" (GitHub names are case-insensitive). */
export function repoSlug(repoUrl: string): string {
  return new URL(repoUrl).pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase();
}

export async function verifyToken(repoUrl: string): Promise<string> {
  return createHmac('sha256', await getSecret()).update(repoSlug(repoUrl)).digest('hex').slice(0, 24);
}

/** True if the repo's default branch has `.canary-verify` containing this repo's token. */
export async function isOwnerVerified(repoUrl: string): Promise<boolean> {
  try {
    const slug = repoSlug(repoUrl);
    if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) return false;
    const res = await fetch(`https://raw.githubusercontent.com/${slug}/HEAD/${VERIFY_FILE}`, {
      signal: AbortSignal.timeout(8_000),
      redirect: 'error',
    });
    if (!res.ok) return false;
    const body = (await res.text()).slice(0, 500);
    return body.includes(`canary-verify=${await verifyToken(repoUrl)}`);
  } catch {
    return false;
  }
}

async function ipHash(ip: string): Promise<string> {
  return createHash('sha256').update(`${await getSecret()}|${ip}`).digest('hex').slice(0, 16);
}

export async function auditLog(entry: { scanId: string; repo: string; security: boolean; verified: boolean; ip: string }): Promise<void> {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const line = JSON.stringify({
      t: new Date().toISOString(),
      scan: entry.scanId.slice(0, 8),
      repo: repoSlug(entry.repo),
      security: entry.security,
      verified: entry.verified,
      ip: await ipHash(entry.ip),
    });
    await fs.appendFile(LOG_FILE, line + '\n', 'utf8');
  } catch {
    /* logging must never break a scan */
  }
}

/** Drop log lines older than the retention period. Called once at startup. */
export async function pruneAuditLog(): Promise<void> {
  try {
    const lines = (await fs.readFile(LOG_FILE, 'utf8')).split('\n').filter(Boolean);
    const keep = lines.filter((l) => {
      try {
        return Date.now() - Date.parse(JSON.parse(l).t) < RETENTION_MS;
      } catch {
        return false;
      }
    });
    if (keep.length !== lines.length) await fs.writeFile(LOG_FILE, keep.join('\n') + (keep.length ? '\n' : ''), 'utf8');
  } catch {
    /* no log yet */
  }
}
