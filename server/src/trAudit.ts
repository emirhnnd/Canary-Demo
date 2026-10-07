// Türkiye Uyum Tarayıcısı (Canary TR's own feature, not in the original Canary).
// A fast static scan for code patterns that break for users in Turkey. It needs no AI,
// so it still works when Gemini is down or out of quota. Findings are also handed to
// the AI as hints so it writes Turkey-specific tests aimed at them.

import type { TrAuditItem, TrAuditReport, TrSeverity } from './types.ts';

interface SourceLike {
  path: string;
  content: string;
}

interface LineRule {
  id: string;
  severity: TrSeverity;
  title: string;
  why: string;
  fix: string;
  test: (line: string) => boolean;
}

const WEIGHT: Record<TrSeverity, number> = { critical: 15, high: 10, medium: 5, low: 2 };
const MAX_LOCATIONS = 6;

const LINE_RULES: LineRule[] = [
  {
    id: 'tr-number',
    severity: 'critical',
    title: 'Fiyat metni Number()/parseFloat() ile okunuyor',
    why: 'Türkiye\'de fiyatlar "1.249,90" biçimindedir. Number("1.249,90") NaN, parseFloat("1.249,90") 1.249 döner; toplamlar "NaN ₺" ya da yanlış çıkar.',
    fix: "Number(fiyat.replace(/\\./g, '').replace(',', '.'))  // veya sayıyı API'den sayı olarak alın",
    test: (l) =>
      /\b(Number|parseFloat)\s*\([^)]*\b(price|fiyat|tutar|amount|total|toplam|ucret|ücret|bakiye|cost|odeme|ödeme)/i.test(l),
  },
  {
    id: 'tr-case',
    severity: 'high',
    title: 'Türkçe İ/ı: yerel belirtilmeden büyük/küçük harf dönüşümü',
    why: '"IŞIK".toLowerCase() → "işik" (doğrusu "ışık"); "istanbul".toUpperCase() → "ISTANBUL" (doğrusu "İSTANBUL"). Arama, kelime kontrolü, kupon ve e-posta karşılaştırmaları bozulur.',
    fix: ".toLocaleLowerCase('tr-TR') / .toLocaleUpperCase('tr-TR')",
    test: (l) => /\.(toUpperCase|toLowerCase)\(\s*\)/.test(l),
  },
  {
    id: 'tr-utc-date',
    severity: 'high',
    title: 'Bugünün tarihi UTC\'ye göre hesaplanıyor',
    why: 'toISOString() UTC saatini kullanır. Türkiye UTC+3 olduğu için gece 00:00–03:00 arasında "bugün" bir önceki gün olur: seriler, günlük görevler ve teslim tarihleri kayar.',
    fix: "new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' })  // \"2026-10-08\"",
    test: (l) => /toISOString\(\)\s*\.\s*(split|slice|substring|substr)\(/.test(l),
  },
  {
    id: 'tr-money-format',
    severity: 'medium',
    title: 'Para/sayı İngilizce biçimde gösteriliyor',
    why: 'toFixed(2), "$", "USD" ya da "en-US" Türk kullanıcıya "1249.90" / "$1,249.90" gösterir; doğrusu "1.249,90 ₺".',
    fix: "new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(tutar)",
    test: (l) => /currency\s*:\s*['"](USD|EUR)['"]|['"]en-US['"]|['"`>]\s?\$\d|\.toFixed\(\s*2\s*\)/.test(l),
  },
  {
    id: 'tr-locale-date',
    severity: 'low',
    title: 'Tarih/saat dil belirtilmeden biçimleniyor',
    why: 'toLocaleDateString() ziyaretçinin tarayıcı diline göre değişir; İngilizce tarayıcıda "10/8/2026" görünür, Türkçe beklenen "08.10.2026".',
    fix: "tarih.toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' })",
    test: (l) => /\.(toLocaleDateString|toLocaleTimeString|toLocaleString)\(\s*\)/.test(l),
  },
  {
    id: 'tr-sort',
    severity: 'low',
    title: 'Türkçe alfabetik sıralama yanlış olabilir',
    why: '.sort() ve dil verilmeden localeCompare() Ç, Ğ, İ, Ö, Ş, Ü harflerini alfabenin sonuna atabilir ("Çanakkale" "Zonguldak"tan sonra gelir).',
    fix: "liste.sort((a, b) => a.localeCompare(b, 'tr'))",
    test: (l) => /\.sort\(\s*\)|\.localeCompare\(\s*[^,()]+\)/.test(l),
  },
];

const TURKISH_CHARS = /[çğıöşüÇĞİÖŞÜ]/;

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function penalty(severity: TrSeverity, count: number): number {
  if (count === 0) return 0;
  const w = WEIGHT[severity];
  // First occurrence costs the full weight, later ones a quarter each, at most 2× per rule.
  return Math.min(2 * w, w + (count - 1) * (w / 4));
}

export function runTrAudit(files: SourceLike[], indexHtml: string | null): TrAuditReport {
  const items: TrAuditItem[] = [];

  for (const rule of LINE_RULES) {
    const locations: TrAuditItem['locations'] = [];
    let count = 0;
    for (const f of files) {
      const lines = f.content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length > 400 || isComment(line) || /toLocale(Upper|Lower)Case\(/.test(line)) continue;
        if (!rule.test(line)) continue;
        count++;
        if (locations.length < MAX_LOCATIONS) {
          locations.push({ file: f.path, line: i + 1, text: line.trim().slice(0, 160) });
        }
      }
    }
    if (count) {
      items.push({ id: rule.id, severity: rule.severity, title: rule.title, why: rule.why, fix: rule.fix, count, locations });
    }
  }

  // ---- project-level checks ----
  const all = files.map((f) => f.content).join('\n');
  const usesTurkish = TURKISH_CHARS.test(all);

  if (indexHtml !== null && usesTurkish && !/<html[^>]*\blang=["']tr/i.test(indexHtml)) {
    items.push({
      id: 'tr-lang',
      severity: 'medium',
      title: 'Sayfa dili Türkçe olarak işaretlenmemiş',
      why: 'Arayüz Türkçe ama index.html\'de lang="tr" yok. Ekran okuyucular metni yanlış dilde okur, tarayıcı gereksiz çeviri önerir, CSS büyük harf dönüşümü İ/ı\'yı bozar.',
      fix: '<html lang="tr">',
      count: 1,
      locations: [{ file: 'index.html', line: 2, text: (indexHtml.match(/<html[^>]*>/i) ?? ['<html>'])[0] }],
    });
  }

  const storesData = /localStorage|sessionStorage|document\.cookie|gtag\(|analytics|indexedDB/i.test(all);
  const hasNotice = /kvkk|aydınlatma|aydinlatma|çerez|cerez|cookie[-_ ]?(consent|banner|notice)/i.test(all + (indexHtml ?? ''));
  if (storesData && !hasNotice) {
    const where = files.find((f) => /localStorage|sessionStorage|document\.cookie|gtag\(|indexedDB/.test(f.content));
    const idx = where ? where.content.split(/\r?\n/).findIndex((l) => /localStorage|sessionStorage|document\.cookie|gtag\(|indexedDB/.test(l)) : -1;
    items.push({
      id: 'tr-kvkk',
      severity: 'medium',
      title: 'Kullanıcı verisi saklanıyor ama KVKK/çerez bilgilendirmesi yok',
      why: 'Tarayıcıda kullanıcıya ait veri (profil, skor, oturum) saklanıyor; KVKK aydınlatma metni ya da çerez/yerel depolama bilgilendirmesi bulunamadı.',
      fix: 'İlk açılışta KVKK aydınlatma + çerez bilgilendirme bandı ekleyin; onay alınmadan izleme yapmayın.',
      count: 1,
      locations: where && idx >= 0 ? [{ file: where.path, line: idx + 1, text: where.content.split(/\r?\n/)[idx].trim().slice(0, 160) }] : [],
    });
  }

  const order: Record<TrSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  items.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
  const score = Math.max(0, Math.round(100 - items.reduce((s, it) => s + penalty(it.severity, it.count), 0)));
  return { score, filesScanned: files.length, items };
}

/** Short text for the AI: which Turkey risks the static scan already saw. */
export function auditHint(report: TrAuditReport): string {
  if (!report.items.length) return '';
  const lines = report.items
    .slice(0, 6)
    .map((it) => `- ${it.title} (${it.locations.map((l) => `${l.file}:${l.line}`).slice(0, 3).join(', ')})`);
  return `\nThe Türkiye static scan already found these Turkey-specific risks. Prefer "region": "tr" flows that exercise them in the UI:\n${lines.join('\n')}`;
}
