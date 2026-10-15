import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

/** Set ALLOW_LOCAL_TARGETS=1 to let appUrl point at localhost / private IPs (local demos only). */
const allowLocal = () => ['1', 'true', 'yes'].includes(String(process.env.ALLOW_LOCAL_TARGETS ?? '').toLowerCase());

export class ValidationError extends Error {}

/** Only https://github.com/<owner>/<repo>[.git] — no other hosts, schemes or credentials. */
export function validateRepoUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new ValidationError('repoUrl geçerli bir URL olmalı');
  }
  if (u.protocol !== 'https:' || !['github.com', 'www.github.com'].includes(u.hostname.toLowerCase())) {
    throw new ValidationError('repoUrl yalnızca https://github.com/<sahip>/<repo> olabilir');
  }
  if (u.username || u.password || u.port || u.search || u.hash) {
    throw new ValidationError('repoUrl kimlik bilgisi, port, sorgu veya parça içeremez');
  }
  if (!/^\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/.test(u.pathname)) {
    throw new ValidationError('repoUrl https://github.com/<sahip>/<repo> biçiminde olmalı');
  }
  return `https://github.com${u.pathname.replace(/\/+$/, '')}`;
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved and metadata addresses. */
export function isPrivateIp(ip: string): boolean {
  const v4mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped) ip = v4mapped[1];
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const s = ip.toLowerCase();
  return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff');
}

const hostVerdict = new Map<string, boolean>();

/**
 * Used for every request the headless browser makes: true if the host is (or resolves to) a
 * private/loopback address. Blocks DNS rebinding and redirects into the internal network.
 */
export async function isBlockedHost(hostname: string): Promise<boolean> {
  if (allowLocal()) return false;
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (isIP(host)) return isPrivateIp(host);
  const cached = hostVerdict.get(host);
  if (cached !== undefined) return cached;
  let blocked: boolean;
  try {
    const addrs = await dns.lookup(host, { all: true });
    blocked = !addrs.length || addrs.some((a) => isPrivateIp(a.address));
  } catch {
    blocked = true;
  }
  if (hostVerdict.size > 500) hostVerdict.clear();
  hostVerdict.set(host, blocked);
  return blocked;
}

/** http(s) only, no credentials, and the host must not resolve to a private address. */
export async function validateAppUrl(input: string): Promise<string> {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new ValidationError('appUrl geçerli bir URL olmalı');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ValidationError('appUrl http(s) olmalı');
  if (u.username || u.password) throw new ValidationError('appUrl kimlik bilgisi içeremez');
  if (allowLocal()) return u.toString();

  if (u.protocol !== 'https:') throw new ValidationError('appUrl https olmalı');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new ValidationError('appUrl yerel/özel bir adrese işaret edemez');
  }
  let addrs: string[];
  if (isIP(host)) addrs = [host];
  else {
    try {
      addrs = (await dns.lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw new ValidationError('appUrl alan adı çözümlenemedi');
    }
  }
  if (!addrs.length || addrs.some(isPrivateIp)) throw new ValidationError('appUrl yerel/özel bir adrese işaret edemez');
  return u.toString();
}
