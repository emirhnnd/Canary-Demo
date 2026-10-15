import type { LogLevel, ScanEvent } from './types.ts';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** First line of an error, with local file paths and URL credentials removed (it is streamed to the client). */
export function errMsg(e: unknown): string {
  const raw = e instanceof Error ? e.message.split('\n')[0] : String(e);
  return raw
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//***@')
    .replace(/(?<![\w])[A-Za-z]:[\\/](?!\/)[^\s'"]+/g, '<path>')
    .replace(/(^|[\s'"(])\/(?:[\w.-]+\/)+[\w.-]+/g, '$1<path>');
}

export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Thrown when the browser closed the SSE connection; stops the pipeline quietly. */
export class AbortedError extends Error {
  constructor() {
    super('client disconnected');
  }
}

/** Everything a scan needs to talk to the client. */
export interface ScanContext {
  scanId: string;
  repoUrl: string;
  appUrl: string;
  /** 'tr' = Canary TR: Turkish browser locale, Turkey-specific checks, Turkish AI output */
  profile: 'tr' | 'global';
  /** passive security audit; only set when the requester confirmed they are authorized */
  security: boolean;
  /** repo owner proved control via .canary-verify: full security report; otherwise restricted */
  verified: boolean;
  emit: (event: ScanEvent) => void;
  log: (level: LogLevel, message: string) => void;
  isAborted: () => boolean;
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'flow'
  );
}

export function relativeTime(date: Date): string {
  const sec = Math.max(1, Math.round((Date.now() - date.getTime()) / 1000));
  const units: [number, string][] = [
    [60 * 60 * 24 * 365, 'year'],
    [60 * 60 * 24 * 30, 'month'],
    [60 * 60 * 24 * 7, 'week'],
    [60 * 60 * 24, 'day'],
    [60 * 60, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    if (sec >= size) {
      const n = Math.floor(sec / size);
      return `${n} ${name}${n > 1 ? 's' : ''} ago`;
    }
  }
  return 'just now';
}
