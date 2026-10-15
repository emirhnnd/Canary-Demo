// Güvenlik Tarayıcısı — passive, defensive static analysis of source code.
//
// Ethical / legal design:
//  * It only READS the cloned source (public GitHub repo, or one the user says they may test).
//    It never sends exploit payloads, never probes the running app, never brute-forces anything.
//  * Dependency check asks OSV.dev (a public advisory database) for package name + version only.
//  * Secrets found in code are MASKED in the report, never stored or logged in full.
//  * Every finding comes with a CWE id and a concrete fix so the owner can act on it.

import type { SecAuditItem, SecAuditReport, TrSeverity } from './types.ts';

interface SourceLike {
  path: string;
  content: string;
}

interface Rule {
  id: string;
  severity: TrSeverity;
  title: string;
  cwe: string;
  why: string;
  fix: string;
  test: (line: string) => boolean;
  /** same sink, but fed by a variable that holds req.body/query/params (see taint tracking) */
  taint?: (line: string, v: string) => boolean;
  /** secrets: mask the match in the reported line */
  mask?: RegExp;
}

const WEIGHT: Record<TrSeverity, number> = { critical: 20, high: 12, medium: 6, low: 2 };
const MAX_LOCATIONS = 6;

export const SECRET_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /gh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub token
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI-style secret key
  /xox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack token
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  /(?:secret|passw(?:or)?d|api[_-]?key|token)\s*[:=]\s*['"][^'"\s]{12,}['"]/gi,
];

const RULES: Rule[] = [
  {
    id: 'sec-secret',
    severity: 'critical',
    title: 'Kodda gömülü gizli anahtar / parola',
    cwe: 'CWE-798',
    why: 'Depoya giren bir anahtar sonsuza dek git geçmişinde kalır; herkes okuyabilir ve hesabınızı kullanabilir.',
    fix: 'Anahtarı hemen iptal edip yenileyin; değeri ortam değişkeninden (.env, git\'e eklenmez) okuyun.',
    test: (l) => SECRET_PATTERNS.some((p) => new RegExp(p.source, p.flags.replace('g', '')).test(l)),
    mask: /(['"])[^'"\s]{6,}(['"])/g,
  },
  {
    id: 'sec-eval',
    severity: 'high',
    title: 'eval() / new Function() kullanımı',
    cwe: 'CWE-95',
    why: 'Kullanıcı girdisi bu çağrılara ulaşırsa saldırgan kendi kodunu çalıştırır.',
    fix: 'eval yerine JSON.parse veya açık bir ayrıştırıcı kullanın; dinamik kod üretmeyin.',
    test: (l) => /(^|[^\w.])eval\s*\(|new Function\s*\(/.test(l),
  },
  {
    id: 'sec-xss',
    severity: 'high',
    title: 'HTML\'e doğrudan yazma (XSS riski)',
    cwe: 'CWE-79',
    why: 'innerHTML / dangerouslySetInnerHTML / document.write temizlenmemiş veriyle kullanılırsa saldırgan sayfada script çalıştırır.',
    fix: 'textContent kullanın veya HTML\'i DOMPurify ile temizleyin.',
    // `==` is a comparison and assigning a constant string is harmless
    test: (l) =>
      (/\.(inner|outer)HTML\s*=(?!=)/.test(l) && !/\.(inner|outer)HTML\s*=\s*(['"`])[^$'"`]*\2\s*;?\s*$/.test(l)) ||
      /dangerouslySetInnerHTML|document\.write(ln)?\s*\(|insertAdjacentHTML\s*\(/.test(l),
  },
  {
    id: 'sec-sqli',
    severity: 'high',
    title: 'Metin birleştirmeyle SQL sorgusu (SQL injection riski)',
    cwe: 'CWE-89',
    why: 'Kullanıcı girdisi sorguya birleştirilirse veritabanı okunabilir/silinebilir.',
    fix: 'Parametreli sorgu kullanın: db.query("SELECT … WHERE id = $1", [id]).',
    test: (l) =>
      /\b(query|execute|raw)\s*\(\s*(`[^`]*\$\{|['"][^'"]*(SELECT|INSERT|UPDATE|DELETE)[^'"]*['"]\s*\+)/i.test(l) ||
      /['"`]\s*(SELECT .* FROM|INSERT INTO|UPDATE .* SET|DELETE FROM)[^'"`]*(\$\{|['"]{1,2}\s*\+)/i.test(l),
  },
  {
    id: 'sec-cmd',
    severity: 'high',
    title: 'Değişkenle kabuk komutu çalıştırma (komut enjeksiyonu riski)',
    cwe: 'CWE-78',
    why: 'exec()/execSync() girdiyi kabuğa verir; ";" veya "&&" ile ek komut çalıştırılabilir.',
    fix: 'execFile/spawn ile argümanları dizi olarak verin, shell:true kullanmayın.',
    test: (l) => /\b(exec|execSync)\s*\(\s*(`[^`]*\$\{|['"][^'"]*['"]\s*\+|[^'"`)\s][^)]*\+)/.test(l) || /shell\s*:\s*true/.test(l),
  },
  {
    id: 'sec-nosql',
    severity: 'high',
    title: 'İstek verisi doğrudan NoSQL sorgusuna giriyor (NoSQL enjeksiyonu)',
    cwe: 'CWE-943',
    why: 'req.body/query doğrudan sorguya verilirse saldırıcı { "$ne": null } gibi bir nesne göndererek parolayı atlar; $where ise sunucuda JavaScript çalıştırır.',
    fix: 'Girdiyi önce metne çevirin (String(req.body.x)) ve şemayla doğrulayın; $where kullanmayın; mongo-sanitize veya express-mongo-sanitize ekleyin.',
    test: (l) =>
      /\$where\b/.test(l) ||
      /\.(find|findOne|findOneAnd\w+|update\w*|delete\w+|remove|count\w*|aggregate)\s*\(\s*(\{[^}]*)?(?<!String\(|Number\(|parseInt\(|parseFloat\(|ObjectId\(|Boolean\()req\.(body|query|params)\b/.test(l),
    taint: (l, v) =>
      new RegExp(`\\.(find|findOne|findOneAnd\\w+|update\\w*|delete\\w+|remove|count\\w*|aggregate)\\s*\\(\\s*(\\{[^}]*)?(?<!String\\(|Number\\(|parseInt\\(|parseFloat\\(|ObjectId\\(|Boolean\\()\\b${v}\\b(?!\\s*\\()`).test(l),
  },
  {
    id: 'sec-open-redirect',
    severity: 'medium',
    title: 'Kullanıcının verdiği adrese yönlendirme (açık yönlendirme)',
    cwe: 'CWE-601',
    why: 'Yönlendirme adresi istekten geliyorsa saldırıcı, sizin alan adınızla başlayan bir bağlantıyla kurbanı kendi oltalama sitesine gönderir.',
    fix: 'Yönlendirmeyi yalnızca izinli bir listeye ya da "/" ile başlayan (ve "//" ile başlamayan) yerel yollara izin verin.',
    test: (l) =>
      (/res\.redirect\s*\([^)]*req\.(query|body|params)\b/.test(l) && !/res\.redirect\s*\(\s*(['"`])\/(?!\/)/.test(l)) ||
      /(window\.)?location(\.href)?\s*=(?!=)\s*[^;]*(location\.search|searchParams|\.get\(\s*['"](next|redirect|redirect_?url|return_?url|url)['"]\s*\))/.test(l),
    taint: (l, v) => new RegExp(`res\\.redirect\\s*\\([^)]*\\b${v}\\b`).test(l) && !/res\.redirect\s*\(\s*(['"`])\/(?!\/)/.test(l),
  },
  {
    id: 'sec-cookie-flags',
    severity: 'medium',
    title: 'Oturum çerezinde httpOnly/secure bayrağı kapatılmış',
    cwe: 'CWE-1004',
    why: 'httpOnly kapalıysa sayfadaki bir XSS oturum çerezini çalar; secure kapalıysa çerez şifresiz http üzerinden de gider.',
    fix: 'cookie: { httpOnly: true, secure: true, sameSite: "lax" } kullanın (secure için https gerekir).',
    test: (l) => /\b(httpOnly|secure)\s*:\s*false\b/.test(l),
  },
  {
    id: 'sec-tls',
    severity: 'high',
    title: 'TLS sertifika doğrulaması kapatılmış',
    cwe: 'CWE-295',
    why: 'Doğrulama kapalıyken ortadaki saldırgan (MITM) trafiği okuyup değiştirebilir.',
    fix: 'rejectUnauthorized:false ve NODE_TLS_REJECT_UNAUTHORIZED=0 ayarlarını kaldırın.',
    test: (l) => /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/.test(l),
  },
  {
    id: 'sec-cors',
    severity: 'medium',
    title: 'CORS her kaynağa açık',
    cwe: 'CWE-942',
    why: 'Access-Control-Allow-Origin: * (veya cors() varsayılanı) başka sitelerin API\'nizi tarayıcıdan çağırmasına izin verir.',
    fix: 'cors({ origin: ["https://siteniz.com"] }) ile izinli kaynakları sınırlayın.',
    test: (l) => /Access-Control-Allow-Origin['"]?\s*[,:]\s*['"]\*['"]|origin\s*:\s*(true|['"]\*['"])|\bcors\(\s*\)/.test(l),
  },
  {
    id: 'sec-weak-hash',
    severity: 'medium',
    title: 'Zayıf özet algoritması (MD5 / SHA-1)',
    cwe: 'CWE-328',
    why: 'MD5 ve SHA-1 çakışmaya açıktır; parola saklamak için hiç uygun değildir.',
    fix: 'Parolalar için bcrypt/argon2, genel özet için SHA-256 kullanın.',
    test: (l) => /createHash\(\s*['"](md5|sha1)['"]\s*\)|\b(md5|sha1)\s*\(/i.test(l),
  },
  {
    id: 'sec-random',
    severity: 'medium',
    title: 'Güvenlik değeri için Math.random()',
    cwe: 'CWE-338',
    why: 'Math.random() tahmin edilebilir; token, oturum ya da parola sıfırlama kodu için kullanılmamalıdır.',
    fix: 'crypto.randomUUID() veya crypto.getRandomValues() kullanın.',
    test: (l) => /Math\.random\(\)/.test(l) && /(token|secret|session|otp|password|parola|reset|key|nonce)/i.test(l),
  },
  {
    id: 'sec-token-storage',
    severity: 'medium',
    title: 'Kimlik token\'ı localStorage\'da',
    cwe: 'CWE-922',
    why: 'localStorage\'daki token, sayfadaki herhangi bir XSS ile çalınır.',
    fix: 'Oturum token\'ını HttpOnly + Secure + SameSite çerezinde tutun.',
    test: (l) => /(localStorage|sessionStorage)\.setItem\(\s*['"][^'"]*(token|jwt|auth|session)[^'"]*['"]/i.test(l),
  },
  {
    id: 'sec-jwt',
    severity: 'high',
    title: 'JWT doğrulaması zayıf',
    cwe: 'CWE-347',
    why: '"none" algoritması ya da verify yerine decode kullanmak, sahte token kabul edilmesine yol açar.',
    fix: 'jwt.verify(token, secret, { algorithms: ["HS256"] }) kullanın; decode ile yetkilendirme yapmayın.',
    test: (l) => /algorithms?\s*:\s*\[?\s*['"]none['"]|jwt\.decode\s*\(/i.test(l),
  },
  {
    id: 'sec-http',
    severity: 'low',
    title: 'Şifresiz http:// adresi',
    cwe: 'CWE-319',
    why: 'Düz http trafiği ağdaki herkes tarafından okunabilir/değiştirilebilir.',
    fix: 'Canlı adresler için https:// kullanın.',
    test: (l) => /['"`]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|www\.w3\.org|schemas\.|json-schema)/i.test(l),
  },
  {
    id: 'sec-blank',
    severity: 'low',
    title: 'target="_blank" bağlantısında rel="noopener" yok',
    cwe: 'CWE-1022',
    why: 'Açılan sayfa window.opener ile sizin sayfanızı yönlendirebilir (reverse tabnabbing).',
    fix: 'rel="noopener noreferrer" ekleyin.',
    test: (l) => /target=['"]_blank['"]/.test(l) && !/rel=/.test(l),
  },
];

/** Test/fixture code holds deliberately bad snippets; only leaked secrets matter there. */
const TEST_PATH = /(^|\/)(tests?|__tests__|e2e|fixtures?|__mocks__|cypress)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;

const TAINT_WINDOW = 50;
const SAFE_WRAP = /^(String|Number|parseInt|parseFloat|Boolean|ObjectId|encodeURIComponent)\s*\(/;

/** Variable names that receive req.body/query/params on this line (not wrapped by a converter). */
function taintedAssignments(line: string): string[] {
  const m = line.match(/^\s*(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*(.+)$/);
  if (!m) return [];
  const rhs = m[2].trim();
  if (SAFE_WRAP.test(rhs) || !/^req\.(body|query|params)\b/.test(rhs)) return [];
  if (m[1].startsWith('{')) {
    // const { a, b: c = 1 } = req.body  -> a, c
    return m[1].slice(1, -1).split(',').map((p) => p.split('=')[0].split(':').pop()!.trim()).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  }
  // `const x = req.body.a.length` etc. is still a value derived from input; `.length`/comparison is not a string
  if (/\.length\b|[=!<>]=|\?/.test(rhs)) return [];
  return [m[1]];
}

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#');
}

function maskLine(line: string, rule: Rule): string {
  let out = line.trim().slice(0, 160);
  if (rule.mask) out = out.replace(rule.mask, '$1****$2');
  for (const p of SECRET_PATTERNS) out = out.replace(new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g'), (m) => m.slice(0, 4) + '****');
  return out;
}

export function penalty(severity: TrSeverity, count: number): number {
  const w = WEIGHT[severity];
  return Math.min(2 * w, w + (count - 1) * (w / 4));
}

export function scoreOf(items: SecAuditItem[]): number {
  // count can drop to 0 when the AI review dismissed every occurrence: that costs nothing
  return Math.max(0, Math.round(100 - items.reduce((s, it) => s + (it.count > 0 ? penalty(it.severity, it.count) : 0), 0)));
}

/** Remove secret-looking values before text leaves this machine (e.g. to an AI provider). */
export function maskSecrets(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g'), '«gizli»');
  return out.replace(/((?:secret|passw(?:or)?d|api[_-]?key|token|auth)\w*\s*[:=]\s*)(['"`])[^'"`]{4,}\2/gi, '$1$2«gizli»$2');
}

/** Tracked files that should never be in a repository. */
const SENSITIVE_FILES = /(^|\/)(\.env(\.[\w-]+)?|id_rsa|id_ed25519|.*\.pem|.*\.key|.*\.pfx|.*\.p12|.*\.jks|.*\.keystore|credentials\.json|serviceAccount.*\.json)$/i;

export function runSecAudit(files: SourceLike[], repoFileList: string[] = []): SecAuditReport {
  const items: SecAuditItem[] = [];
  const ruleById = new Map(RULES.map((r) => [r.id, r]));

  for (const rule of RULES) {
    const locations: SecAuditItem['locations'] = [];
    let count = 0;
    for (const f of files) {
      if (/(^|\/)(secAudit|trAudit)\.[jt]s$/.test(f.path)) continue; // the scanner's own rule text
      if (rule.id !== 'sec-secret' && TEST_PATH.test(f.path)) continue;
      const lines = f.content.split(/\r?\n/);
      const tainted = new Map<string, number>(); // variable -> last line it is still considered tainted
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length > 500 || isComment(line)) continue;
        if (rule.id === 'sec-secret' && /(process\.env|import\.meta\.env|your[_-]?(key|api)|example|placeholder|xxx)/i.test(line)) continue;
        let hit = rule.test(line);
        if (rule.taint) {
          // a new top-level function/handler starts: earlier variables are out of scope
          if (/^\S.*(\bfunction\b|=>)/.test(line)) tainted.clear();
          for (const [v, end] of [...tainted]) {
            if (end < i) { tainted.delete(v); continue; }
            const name = v.replace(/\$/g, '\\$');
            if (!new RegExp(`(^|[^\\w$])${name}(?![\\w$])`).test(line)) continue;
            // validated or reassigned: treat as sanitized (fewer false alarms over catching every case)
            if (new RegExp(`(^|[^\\w$.])${name}\\s*=[^=]`).test(line) || /startsWith|includes|indexOf|\.test\(|\.match\(|allow|whitelist|valid|sanitiz|isSafe|new URL/i.test(line)) tainted.delete(v);
            else if (!hit && rule.taint(line, name)) hit = true;
          }
          for (const v of taintedAssignments(line)) tainted.set(v, i + TAINT_WINDOW);
        }
        if (!hit) continue;
        count++;
        if (locations.length < MAX_LOCATIONS) locations.push({ file: f.path, line: i + 1, text: maskLine(line, ruleById.get(rule.id)!) });
      }
    }
    if (count) items.push({ id: rule.id, severity: rule.severity, title: rule.title, cwe: rule.cwe, why: rule.why, fix: rule.fix, count, locations });
  }

  const leaked = repoFileList.filter((p) => SENSITIVE_FILES.test(p) && !/\.(example|sample|template)$/i.test(p));
  if (leaked.length) {
    items.push({
      id: 'sec-tracked-secret-file',
      severity: 'critical',
      title: 'Gizli dosya depoya eklenmiş (.env, özel anahtar vb.)',
      cwe: 'CWE-540',
      why: 'Bu dosyalar herkese açık depoda okunabilir ve git geçmişinden silinse bile kopyalanmış olabilir.',
      fix: 'Dosyayı git\'ten çıkarın (git rm --cached), .gitignore\'a ekleyin ve içindeki tüm anahtarları yenileyin.',
      count: leaked.length,
      locations: leaked.slice(0, MAX_LOCATIONS).map((p) => ({ file: p, line: 1, text: '(içerik gösterilmiyor)' })),
    });
  }

  // ---- project-level checks (something is MISSING, so there is no single bad line) ----
  const own = files.filter((f) => !/(^|\/)(secAudit|trAudit)\.[jt]s$/.test(f.path) && !TEST_PATH.test(f.path));
  // Commented-out protection (e.g. "// app.use(csrf())") is not protection.
  const everything = own.map((f) => f.content.split(/\r?\n/).filter((l) => !isComment(l)).join('\n')).join('\n');
  const firstLine = (re: RegExp) => {
    for (const f of own) {
      const lines = f.content.split(/\r?\n/);
      const i = lines.findIndex((l) => !isComment(l) && re.test(l));
      if (i >= 0) return { file: f.path, line: i + 1, text: lines[i].trim().slice(0, 160) };
    }
    return null;
  };
  const isServer = /require\(\s*['"]express['"]\s*\)|from\s+['"]express['"]/.test(everything) && /\.listen\s*\(/.test(everything);

  const usesBrowserSession = /express-session|cookie-session|cookieParser|cookie-parser|res\.cookie\s*\(|req\.session\b/.test(everything);
  const hasStateChange = /\b(app|router)\.(post|put|patch|delete)\s*\(/.test(everything);
  const hasCsrf = /csurf|csrf|lusca|sameSite|samesite|x-csrf|xsrf/i.test(everything);
  if (isServer && usesBrowserSession && hasStateChange && !hasCsrf) {
    const at = firstLine(/\b(app|router)\.(post|put|patch|delete)\s*\(/);
    items.push({
      id: 'sec-csrf',
      severity: 'medium',
      title: 'Çerez/oturum kullanılıyor ama CSRF koruması bulunamadı',
      cwe: 'CWE-352',
      why: 'Oturum çerezi tarayıcı tarafından her istekte otomatik gönderilir; saldırganın sayfası kullanıcı adına form gönderip işlem yaptırabilir.',
      fix: 'csrf-csrf / lusca gibi bir CSRF belirteci ekleyin ve oturum çerezine sameSite: "lax" (veya "strict") verin.',
      count: 1,
      locations: at ? [at] : [],
    });
  }

  if (isServer && !/helmet/i.test(everything)) {
    const at = firstLine(/require\(\s*['"]express['"]\s*\)|from\s+['"]express['"]/);
    items.push({
      id: 'sec-helmet',
      severity: 'low',
      title: 'Güvenlik başlıkları yok (helmet kullanılmıyor)',
      cwe: 'CWE-693',
      why: 'Content-Security-Policy, X-Content-Type-Options, Strict-Transport-Security gibi başlıklar XSS, tıklama gizleme ve protokol düşürme saldırılarını zorlaştırır; Express varsayılanı bunları göndermez ve X-Powered-By ile sürümünüzü ele verir.',
      fix: 'npm i helmet  →  app.use(helmet())',
      count: 1,
      locations: at ? [at] : [],
    });
  }

  const order: Record<TrSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  items.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
  return { score: scoreOf(items), filesScanned: files.length, items, verified: true };
}

/**
 * Report for a repo whose owner has NOT verified: only categories and counts, so it cannot be
 * used as a map to someone else's weak spots. No paths, lines, code, secret fragments or package names.
 */
export function restrictReport(report: SecAuditReport, verify: { file: string; content: string }): SecAuditReport {
  return {
    score: report.score,
    filesScanned: report.filesScanned,
    items: report.items.filter((it) => it.count > 0).map((it) => ({ ...it, locations: [] })),
    aiReview: report.aiReview,
    dependencies: undefined,
    dependencyCount: report.dependencies?.length,
    verified: false,
    verify,
  };
}

/**
 * Passive dependency check against OSV.dev (public advisory DB). Sends only
 * package name + version. Returns undefined when it cannot be done (offline, no lockfile).
 */
export async function checkDependencies(
  packageLock: string | null,
): Promise<SecAuditReport['dependencies']> {
  if (!packageLock) return undefined;
  let deps: { name: string; version: string }[] = [];
  try {
    const lock = JSON.parse(packageLock) as { packages?: Record<string, { version?: string; dev?: boolean }> };
    for (const [key, v] of Object.entries(lock.packages ?? {})) {
      const m = key.match(/node_modules\/((?:@[^/]+\/)?[^/]+)$/);
      if (m && v.version && !v.dev) deps.push({ name: m[1], version: v.version });
    }
  } catch {
    return undefined;
  }
  deps = deps.slice(0, 1000);
  if (!deps.length) return [];
  try {
    const res = await fetch('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queries: deps.map((d) => ({ package: { name: d.name, ecosystem: 'npm' }, version: d.version })) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { results?: { vulns?: { id: string }[] }[] };
    const out: NonNullable<SecAuditReport['dependencies']> = [];
    (data.results ?? []).forEach((r, i) => {
      if (r.vulns?.length) out.push({ ...deps[i], ids: r.vulns.slice(0, 5).map((v) => v.id) });
    });
    return out.slice(0, 50);
  } catch {
    return undefined;
  }
}
