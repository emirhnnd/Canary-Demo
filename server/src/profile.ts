// Canary TR: what the Türkiye profile adds on top of the original Canary behaviour.
// Kept in one place so the prompts, the browser setup and the UI copy stay consistent.

import type { Profile } from './types.ts';

/** Browser settings for the Türkiye profile: Turkish UI language and Istanbul time. */
export function browserContextOptions(profile: Profile) {
  return profile === 'tr'
    ? {
        locale: 'tr-TR',
        timezoneId: 'Europe/Istanbul',
        extraHTTPHeaders: { 'Accept-Language': 'tr-TR,tr;q=0.9' },
      }
    : {};
}

/** Extra instructions for flow inference. */
export function flowGuide(profile: Profile): string {
  if (profile !== 'tr') return '';
  return `
TÜRKİYE PROFILE (Canary TR) — the app is used by people in Turkey:
- Write "name", "description" and step "label" values in Turkish.
- Use the EXACT visible text from the source for targets (the UI may be Turkish: "Ana Panel", "Giriş Yap", "Sepete Ekle"...).
  Never translate UI text into English.
- In addition to the normal flows, add 1-2 Turkey-specific flows when the code gives you something to test, and set
  "region": "tr" on them. Good candidates:
  * Turkish characters in inputs/search/login: İ/ı/Ş/ğ/Ü/Ö/Ç (e.g. searching "İstanbul" vs "istanbul";
    toUpperCase()/toLowerCase() without the "tr" locale turns "i" into "I" instead of "İ").
  * Money and numbers in Turkish format: "1.249,90 ₺" (dot = thousands, comma = decimals); parsing such strings
    with Number()/parseFloat() gives NaN or wrong values.
  * Turkish identity/contact formats if forms exist: 11-digit TC Kimlik No, IBAN starting with "TR" (26 chars),
    phone "+90 5xx xxx xx xx".
  * KVKK cookie/consent banner, dates as DD.MM.YYYY, Istanbul time zone.
- Only add a Turkey-specific flow if it fits this app. Do not invent features the code does not have.`;
}

/** Extra instructions for writing the Playwright actions. */
export function testGuide(profile: Profile): string {
  if (profile !== 'tr') return '';
  return `
TÜRKİYE PROFILE: the browser runs with locale tr-TR and time zone Europe/Istanbul.
- Use realistic Turkish test data: name "Ayşe Yılmaz", email "ayse.yilmaz+canary@ornek.com.tr", city "İstanbul",
  phone "+90 532 123 45 67", amounts like "1.249,90".
- For "region": "tr" flows, assert the Turkish-specific behaviour (e.g. a search for "İstanbul" shows results,
  a price renders as "₺" without "NaN").
- Selectors must use the exact (possibly Turkish) text from the source.`;
}

/** Language for human-readable AI output (titles, explanations). */
export function outputLanguage(profile: Profile): string {
  return profile === 'tr'
    ? 'Write "title", "expected", "actual" and "explanation" in Turkish (clear, simple Turkish).'
    : 'Write "title", "expected", "actual" and "explanation" in English.';
}
