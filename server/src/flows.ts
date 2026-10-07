import { askJson } from './gemini.ts';
import { slug } from './util.ts';
import { flowGuide } from './profile.ts';
import type { SourceFile } from './repo.ts';
import { VIEWS, type Flow, type FlowStep, type Priority, type Profile, type View } from './types.ts';

const KEY_FILE = /(route|router|page|pages\/|app\/|api|view|screen|auth|login|signup|register|checkout|cart|order|search|product|reset|password|(^|\/)(app|main|index)\.[jt]sx?$)/i;

/** Build the prompt context: file tree + contents of the most relevant files (size-capped). */
export function buildSourceContext(files: SourceFile[], maxChars = 100_000): string {
  const tree = files.map((f) => `- ${f.path}`).join('\n');
  const keyFiles = files.filter((f) => KEY_FILE.test(f.path));
  const chosen = keyFiles.length ? keyFiles : files;
  let budget = maxChars;
  const blocks: string[] = [];
  for (const f of chosen) {
    if (budget <= 0) break;
    const limit = Math.min(12_000, budget);
    const cut = f.content.length > limit;
    const body = f.content.slice(0, limit);
    budget -= body.length;
    const note = cut ? `\n… [NOT SHOWN: the remaining ${f.content.length - limit} characters of this file. It is NOT truncated.]` : '';
    blocks.push(`=== FILE: ${f.path} ===\n${body}${note}`);
  }
  return `FILE TREE:\n${tree}\n\nSOURCE:\n${blocks.join('\n\n')}`;
}

export async function inferFlowsWithGemini(
  files: SourceFile[],
  appUrl: string,
  profile: Profile = 'tr',
  extraHint = '',
): Promise<Flow[]> {
  const prompt = `You are Canary, an AI QA engineer. Read this web app's source code and infer the most
business-critical end-to-end user flows a QA engineer would test.

Return JSON: { "flows": Flow[] } with 5 to 7 flows. Each Flow:
{
  "id": string            // short kebab-case, unique, e.g. "checkout"
  "name": string          // e.g. "Guest checkout"
  "description": string   // one sentence
  "priority": "critical" | "high" | "medium"
  "files": string[]       // repo paths (from the FILE TREE) that implement this flow
  "steps": [              // 3 to 6 steps
    {
      "id": string        // unique within the flow, e.g. "open-cart"
      "label": string     // short imperative, e.g. "'Siparişi Onayla'ya tıkla"
      "url": string       // path on the app, e.g. "/checkout" (relative to ${appUrl})
      "view": one of ${JSON.stringify(VIEWS)}   // closest matching screen type
      "target"?: string   // the UI element the step interacts with, e.g. "Place order button"
    }
  ],
  "region"?: "tr"         // only for Turkey-specific checks (Türkiye profile)
}
Order flows by priority (critical first). Only use file paths that exist in the FILE TREE.
Use routes you actually see in the code for "url".
${flowGuide(profile)}${profile === 'tr' ? extraHint : ''}

${buildSourceContext(files)}`;

  const res = await askJson<{ flows?: unknown[] } | unknown[]>(prompt);
  const raw = Array.isArray(res) ? res : res.flows ?? [];
  const flows = normalizeFlows(raw, files.map((f) => f.path));
  if (flows.length === 0) throw new Error('Gemini returned no usable flows');
  return flows.slice(0, 7);
}

// ---------- normalization (never trust LLM output blindly) ----------

const VIEW_HINTS: [RegExp, View][] = [
  [/(checkout.*error|payment.*(fail|error)|declin)/i, 'checkout-error'],
  [/(checkout|payment|pay|billing|place.?order)/i, 'checkout'],
  [/(cart|basket|bag)/i, 'cart'],
  [/(order|history|purchase)/i, 'orders'],
  [/(reset|forgot|password)/i, 'reset'],
  [/(signup|sign.?up|register|join|onboard)/i, 'signup'],
  [/(login|log.?in|signin|sign.?in|auth|session)/i, 'login'],
  [/(search|find|filter|browse|catalog|list)/i, 'search'],
  [/(product|item|detail|sku)/i, 'product'],
];

export function guessView(...texts: (string | undefined)[]): View {
  const s = texts.filter(Boolean).join(' ');
  for (const [re, v] of VIEW_HINTS) if (re.test(s)) return v;
  return 'product';
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

export function normalizeFlows(raw: unknown[], knownPaths: string[]): Flow[] {
  const known = new Set(knownPaths);
  const usedIds = new Set<string>();
  const out: Flow[] = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const name = asString(r.name, 'Kullanıcı akışı');
    let id = slug(asString(r.id, name));
    while (usedIds.has(id)) id = `${id}-2`;
    usedIds.add(id);

    const priority: Priority = (['critical', 'high', 'medium'] as const).includes(r.priority as Priority)
      ? (r.priority as Priority)
      : 'high';

    const files = (Array.isArray(r.files) ? r.files : [])
      .map((f) => asString(f).replace(/^\.?\//, ''))
      .filter((f) => known.has(f));

    const stepIds = new Set<string>();
    const steps: FlowStep[] = (Array.isArray(r.steps) ? r.steps : [])
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .slice(0, 8)
      .map((s, i) => {
        const label = asString(s.label, `Step ${i + 1}`);
        let sid = slug(asString(s.id, label)) || `step-${i + 1}`;
        while (stepIds.has(sid)) sid = `${sid}-${i + 1}`;
        stepIds.add(sid);
        let url = asString(s.url, '/');
        if (!/^https?:\/\//i.test(url) && !url.startsWith('/')) url = `/${url}`;
        const view = VIEWS.includes(s.view as View) ? (s.view as View) : guessView(label, url, name);
        const target = asString(s.target) || undefined;
        return { id: sid, label, url, view, ...(target ? { target } : {}) };
      });

    if (steps.length === 0) continue;
    out.push({
      id,
      name,
      description: asString(r.description, `${name} akışını uçtan uca doğrular.`),
      ...(r.region === 'tr' ? { region: 'tr' as const } : {}),
      priority,
      files: files.length ? files : knownPaths.slice(0, 2),
      steps,
    });
  }

  const rank = { critical: 0, high: 1, medium: 2 };
  return out.sort((a, b) => rank[a.priority] - rank[b.priority]);
}

// ---------- heuristic fallback (no Gemini) ----------

interface Template {
  id: string;
  name: string;
  description: string;
  priority: Priority;
  match: RegExp;
  steps: FlowStep[];
}

const TEMPLATES: Template[] = [
  {
    id: 'login', name: 'Kullanıcı girişi', priority: 'critical', match: /(login|signin|auth|session)/i,
    description: 'Kayıtlı kullanıcı e-posta ve şifreyle giriş yapar.',
    steps: [
      { id: 'open-login', label: 'Giriş sayfasını aç', url: '/login', view: 'login' },
      { id: 'fill-credentials', label: 'E-posta ve şifre gir', url: '/login', view: 'login', target: 'E-posta alanı' },
      { id: 'submit-login', label: "'Giriş Yap'a tıkla", url: '/login', view: 'login', target: 'Giriş butonu' },
    ],
  },
  {
    id: 'checkout', name: 'Ödeme', priority: 'critical', match: /(checkout|payment|billing|stripe)/i,
    description: 'Müşteri sepetteki ürünlerin ödemesini yapar.',
    steps: [
      { id: 'open-cart', label: 'Sepeti aç', url: '/cart', view: 'cart' },
      { id: 'go-checkout', label: 'Ödemeye geç', url: '/checkout', view: 'checkout', target: 'Ödeme butonu' },
      { id: 'place-order', label: "'Siparişi Onayla'ya tıkla", url: '/checkout', view: 'checkout', target: 'Sipariş butonu' },
    ],
  },
  {
    id: 'add-to-cart', name: 'Sepete ekleme', priority: 'high', match: /(cart|basket)/i,
    description: 'Müşteri bir ürünü sepete ekler.',
    steps: [
      { id: 'open-product', label: 'Bir ürün aç', url: '/products/1', view: 'product' },
      { id: 'add-item', label: "'Sepete Ekle'ye tıkla", url: '/products/1', view: 'product', target: 'Sepete ekle butonu' },
      { id: 'see-cart', label: 'Ürün sepette görünür', url: '/cart', view: 'cart' },
    ],
  },
  {
    id: 'signup', name: 'Hesap oluşturma', priority: 'high', match: /(signup|register|join)/i,
    description: 'Yeni ziyaretçi hesap oluşturur.',
    steps: [
      { id: 'open-signup', label: 'Kayıt sayfasını aç', url: '/signup', view: 'signup' },
      { id: 'fill-form', label: 'Ad, e-posta ve şifre gir', url: '/signup', view: 'signup', target: 'Kayıt formu' },
      { id: 'submit-signup', label: "'Hesap Oluştur'a tıkla", url: '/signup', view: 'signup', target: 'Hesap oluştur butonu' },
    ],
  },
  {
    id: 'search', name: 'Ürün arama', priority: 'high', match: /(search|filter|catalog|product)/i,
    description: 'Ziyaretçi ürün arar ve bir sonucu açar.',
    steps: [
      { id: 'open-search', label: 'Aramayı aç', url: '/search', view: 'search' },
      { id: 'type-query', label: 'Arama yap', url: '/search', view: 'search', target: 'Arama kutusu' },
      { id: 'open-result', label: 'İlk sonucu aç', url: '/products/1', view: 'product' },
    ],
  },
  {
    id: 'orders', name: 'Sipariş geçmişi', priority: 'medium', match: /(order|history|account)/i,
    description: 'Giriş yapmış kullanıcı geçmiş siparişlerini görür.',
    steps: [
      { id: 'open-orders', label: 'Siparişler sayfasını aç', url: '/orders', view: 'orders' },
      { id: 'see-orders', label: 'Sipariş listesi görünür', url: '/orders', view: 'orders' },
    ],
  },
  {
    id: 'password-reset', name: 'Şifre sıfırlama', priority: 'medium', match: /(reset|forgot|password)/i,
    description: 'Kullanıcı şifre sıfırlama e-postası ister.',
    steps: [
      { id: 'open-reset', label: 'Sıfırlama sayfasını aç', url: '/reset-password', view: 'reset' },
      { id: 'request-reset', label: 'E-postayı gönder', url: '/reset-password', view: 'reset', target: 'Bağlantı gönder butonu' },
    ],
  },
];

export function fallbackFlows(paths: string[]): Flow[] {
  const flows: Flow[] = [];
  for (const t of TEMPLATES) {
    const files = paths.filter((p) => t.match.test(p));
    if (files.length) {
      flows.push({ id: t.id, name: t.name, description: t.description, priority: t.priority, files: files.slice(0, 4), steps: t.steps });
    }
  }
  // Always test that the app shell loads.
  if (flows.length < 5) {
    const entry = paths.filter((p) => /(^|\/)(app|main|index|layout|page)\.[jt]sx?$/i.test(p));
    flows.unshift({
      id: 'home',
      name: 'Ana sayfa açılıyor',
      description: 'Ana sayfa hatasız yükleniyor.',
      priority: 'critical',
      files: (entry.length ? entry : paths).slice(0, 3),
      steps: [{ id: 'open-home', label: 'Ana sayfayı aç', url: '/', view: 'search' }],
    });
  }
  return flows.slice(0, 7);
}
