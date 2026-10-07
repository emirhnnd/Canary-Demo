import type { Failure, Flow, Healing, TrAuditReport } from './types';

// Scripted demo scenario (Canary TR): a fictional Turkish e-commerce repo with one realistic,
// Turkey-specific bug. The product API started returning prices in Turkish format ("1.249,90"),
// but the cart total still parses them with Number() — which returns NaN for that format.

export const DEMO_REPO = 'github.com/carsi-tr/magaza';
export const DEMO_APP_URL = 'https://staging.carsi.dev';

export const FILES: string[] = [
  'middleware.ts',
  'lib/db.ts',
  'app/(auth)/kayit/page.tsx',
  'app/(auth)/giris/page.tsx',
  'app/(auth)/sifre-sifirla/page.tsx',
  'app/api/auth/[...nextauth]/route.ts',
  'app/ara/page.tsx',
  'components/AramaKutusu.tsx',
  'lib/metin.ts',
  'app/urun/[id]/page.tsx',
  'components/UrunKarti.tsx',
  'components/SepeteEkleButonu.tsx',
  'lib/sepet.ts',
  'app/sepet/page.tsx',
  'app/odeme/page.tsx',
  'components/KuponGirisi.tsx',
  'lib/kuponlar.ts',
  'lib/fiyat.ts',
  'app/api/urunler/route.ts',
  'app/api/odeme/route.ts',
  'lib/iyzico.ts',
  'app/hesabim/siparisler/page.tsx',
  'components/SiparisSatiri.tsx',
  'components/CerezBandi.tsx',
];

export const FLOWS: Flow[] = [
  {
    id: 'kayit',
    name: 'Yeni üye kaydı',
    description: 'Ziyaretçi e-posta ve şifreyle hesap açar ve mağazaya yönlendirilir.',
    priority: 'high',
    files: ['app/(auth)/kayit/page.tsx', 'app/api/auth/[...nextauth]/route.ts'],
    steps: [
      { id: 's1', label: '/kayit sayfasını aç', url: '/kayit', view: 'signup' },
      { id: 's2', label: 'Ad, e-posta ve şifre gir', url: '/kayit', view: 'signup', target: 'email' },
      { id: 's3', label: '"Hesap Oluştur"a tıkla', url: '/kayit', view: 'signup', target: 'submit' },
      { id: 's4', label: '/ara sayfasına yönlendirilmeyi bekle', url: '/ara', view: 'search' },
    ],
  },
  {
    id: 'giris',
    name: 'Giriş ve oturum',
    description: 'Kayıtlı kullanıcı giriş yapar; oturum sayfa yenilense de korunur.',
    priority: 'high',
    files: ['app/(auth)/giris/page.tsx', 'middleware.ts'],
    steps: [
      { id: 'l1', label: '/giris sayfasını aç', url: '/giris', view: 'login' },
      { id: 'l2', label: 'Geçerli bilgilerle giriş yap', url: '/giris', view: 'login', target: 'submit' },
      { id: 'l3', label: 'Sayfayı yenile, oturumu doğrula', url: '/ara', view: 'search', target: 'avatar' },
    ],
  },
  {
    id: 'sifre',
    name: 'Şifre sıfırlama',
    description: 'Kullanıcı sıfırlama bağlantısı ister ve onay mesajını görür.',
    priority: 'medium',
    files: ['app/(auth)/sifre-sifirla/page.tsx'],
    steps: [
      { id: 'r1', label: '/sifre-sifirla sayfasını aç', url: '/sifre-sifirla', view: 'reset' },
      { id: 'r2', label: 'E-postayı gönder', url: '/sifre-sifirla', view: 'reset', target: 'submit' },
      { id: 'r3', label: 'Onay mesajını bekle', url: '/sifre-sifirla', view: 'reset', target: 'toast' },
    ],
  },
  {
    id: 'arama',
    region: 'tr',
    name: 'Türkçe karakterle arama',
    description: '"Kışlık Bot" araması büyük/küçük harf ve İ/ı farkından etkilenmeden sonuç döndürür.',
    priority: 'medium',
    files: ['app/ara/page.tsx', 'components/AramaKutusu.tsx', 'lib/metin.ts'],
    steps: [
      { id: 'q1', label: 'Arama kutusuna "KIŞLIK BOT" yaz', url: '/ara?q=KI%C5%9ELIK%20BOT', view: 'search', target: 'search' },
      { id: 'q2', label: '"kışlık bot" ile aynı sonuçları bekle', url: '/ara?q=k%C4%B1%C5%9Fl%C4%B1k%20bot', view: 'search', target: 'filter' },
      { id: 'q3', label: 'İlk sonucu aç', url: '/urun/42', view: 'product' },
    ],
  },
  {
    id: 'sepet',
    name: 'Sepete ekleme',
    description: 'Ürün sepete eklenir; sepet rozeti ve sepet sayfası güncellenir.',
    priority: 'high',
    files: ['components/SepeteEkleButonu.tsx', 'lib/sepet.ts', 'app/sepet/page.tsx'],
    steps: [
      { id: 'c1', label: '/urun/42 sayfasını aç', url: '/urun/42', view: 'product' },
      { id: 'c2', label: '"Sepete Ekle"ye tıkla', url: '/urun/42', view: 'product', target: 'add' },
      { id: 'c3', label: 'Sepette 1 ürün olduğunu doğrula', url: '/sepet', view: 'cart', target: 'line' },
    ],
  },
  {
    id: 'odeme',
    region: 'tr',
    name: 'Kuponla ödeme (₺ biçimi)',
    description: 'İNDİRİM100 kuponu (100 ₺) uygulanır ve sipariş verilir.',
    priority: 'critical',
    files: ['app/odeme/page.tsx', 'components/KuponGirisi.tsx', 'lib/kuponlar.ts', 'lib/fiyat.ts', 'app/api/urunler/route.ts'],
    steps: [
      { id: 'k1', label: '/odeme sayfasını 1 ürünle aç', url: '/odeme', view: 'checkout' },
      { id: 'k2', label: '"İNDİRİM100" kuponunu gir', url: '/odeme', view: 'checkout', target: 'coupon' },
      { id: 'k3', label: 'Toplamın 1.149,90 ₺ olduğunu doğrula', url: '/odeme', view: 'checkout-error', target: 'total' },
      { id: 'k4', label: '"Siparişi Onayla"ya tıkla', url: '/odeme', view: 'checkout-error', target: 'pay' },
    ],
  },
  {
    id: 'siparisler',
    name: 'Sipariş geçmişi',
    description: 'Giriş yapmış kullanıcı geçmiş siparişlerini doğru durum ve tarihle görür.',
    priority: 'medium',
    files: ['app/hesabim/siparisler/page.tsx', 'components/SiparisSatiri.tsx', 'lib/db.ts'],
    steps: [
      { id: 'o1', label: '/hesabim/siparisler sayfasını aç', url: '/hesabim/siparisler', view: 'orders' },
      { id: 'o2', label: '3 siparişin listelendiğini doğrula', url: '/hesabim/siparisler', view: 'orders', target: 'rows' },
    ],
  },
];

export const CHECKOUT_FAILURE: Failure = {
  flowId: 'odeme',
  stepId: 'k3',
  title: 'Türkçe biçimli fiyatlar yüzünden sepet toplamı "NaN ₺" oluyor',
  expected: 'Toplam: 1.149,90 ₺  (ara toplam 1.249,90 ₺ − kupon 100,00 ₺)',
  actual: 'Toplam: NaN ₺ — "Siparişi Onayla" butonu devre dışı',
  file: 'lib/fiyat.ts',
  line: 10,
  code: [
    { n: 6, text: '// Sepet toplamını hesaplar. u.fiyat ürün API\'sinden gelir.' },
    { n: 7, text: '' },
    { n: 8, text: 'export function sepetToplami(urunler: SepetUrunu[], kupon?: Kupon) {' },
    { n: 9, text: '  const araToplam = urunler.reduce(' },
    { n: 10, text: '    (t, u) => t + Number(u.fiyat) * u.adet,   // u.fiyat = "1.249,90"', bad: true },
    { n: 11, text: '    0,' },
    { n: 12, text: '  );' },
    { n: 13, text: '' },
    { n: 14, text: '  const indirim = kupon ? kupon.tutar : 0;' },
    { n: 15, text: '  return Math.max(0, araToplam - indirim);' },
    { n: 16, text: '}' },
  ],
  explanation:
    '7c41e9b commit\'iyle ürün API\'si fiyatları Türkçe biçimde ("1.249,90") döndürmeye başladı, ama lib/fiyat.ts hâlâ Number(u.fiyat) kullanıyor. Number("1.249,90") NaN döndüğü için toplam "NaN ₺" oluyor ve "Siparişi Onayla" butonu kilitleniyor. İngilizce yerelde (1,249.90) koşan testler bu hatayı yakalayamaz; Canary TR testleri tr-TR tarayıcıyla çalıştırdığı için yakaladı.',
  commit: {
    sha: '7c41e9b',
    message: 'feat(api): fiyatları TR biçiminde döndür (1.249,90)',
    author: 'dev-bot (AI asistan)',
    when: '2 saat önce',
  },
  fix: {
    before: '    (t, u) => t + Number(u.fiyat) * u.adet,',
    after: "    (t, u) => t + Number(u.fiyat.replace(/\\./g, '').replace(',', '.')) * u.adet,",
  },
};

/** Türkiye Uyum Tarayıcısı sonucu (sahne senaryosu). Statik tarama — yapay zeka kullanmaz. */
export const TR_AUDIT: TrAuditReport = {
  score: 54,
  filesScanned: 31,
  items: [
    {
      id: 'tr-number',
      severity: 'critical',
      title: 'Fiyat metni Number()/parseFloat() ile okunuyor',
      why: 'Türkiye\'de fiyatlar "1.249,90" biçimindedir. Number("1.249,90") NaN, parseFloat("1.249,90") 1.249 döner; toplamlar "NaN ₺" ya da yanlış çıkar.',
      fix: "Number(fiyat.replace(/\\./g, '').replace(',', '.'))  // veya sayıyı API'den sayı olarak alın",
      count: 2,
      locations: [
        { file: 'lib/fiyat.ts', line: 10, text: '(t, u) => t + Number(u.fiyat) * u.adet,   // u.fiyat = "1.249,90"' },
        { file: 'lib/kuponlar.ts', line: 12, text: 'const tutar = parseFloat(kupon.tutar);' },
      ],
    },
    {
      id: 'tr-case',
      severity: 'high',
      title: 'Türkçe İ/ı: yerel belirtilmeden büyük/küçük harf dönüşümü',
      why: '"indirim100".toUpperCase() → "INDIRIM100" (doğrusu "İNDİRİM100"). Kuponu küçük harfle yazan müşterinin kodu reddedilir.',
      fix: ".toLocaleUpperCase('tr-TR')",
      count: 1,
      locations: [{ file: 'components/KuponGirisi.tsx', line: 18, text: 'const kod = girilen.trim().toUpperCase();' }],
    },
    {
      id: 'tr-utc-date',
      severity: 'high',
      title: 'Bugünün tarihi UTC\'ye göre hesaplanıyor',
      why: 'toISOString() UTC saatini kullanır. Türkiye UTC+3 olduğu için gece 00:00–03:00 arasında verilen siparişler bir önceki güne yazılır.',
      fix: "new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' })",
      count: 1,
      locations: [{ file: 'app/api/odeme/route.ts', line: 41, text: 'siparisTarihi: new Date().toISOString().slice(0, 10),' }],
    },
    {
      id: 'tr-money-format',
      severity: 'medium',
      title: 'Para/sayı İngilizce biçimde gösteriliyor',
      why: 'Sipariş onay e-postasında toplam "1149.90 ₺" görünüyor; doğrusu "1.149,90 ₺".',
      fix: "new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(toplam)",
      count: 1,
      locations: [{ file: 'emails/SiparisOnay.tsx', line: 27, text: '<td>{toplam.toFixed(2)} ₺</td>' }],
    },
    {
      id: 'tr-locale-date',
      severity: 'low',
      title: 'Tarih/saat dil belirtilmeden biçimleniyor',
      why: 'toLocaleDateString() ziyaretçinin tarayıcı diline göre değişir; İngilizce tarayıcıda "10/3/2026" görünür.',
      fix: "tarih.toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' })",
      count: 1,
      locations: [{ file: 'components/SiparisSatiri.tsx', line: 11, text: '{new Date(s.tarih).toLocaleDateString()}' }],
    },
  ],
};

/** Kendini onaran test (sahne senaryosu): üretilen test "Log in" aradı, arayüzde "Giriş Yap" var. */
export const HEAL_DEMO: { flowId: string; error: string; healing: Healing } = {
  flowId: 'giris',
  error: "click text='Log in' → locator.click: Timeout 8000ms exceeded.",
  healing: {
    stepId: 'l2',
    stepLabel: 'Geçerli bilgilerle giriş yap',
    reason: '"Log in" butonu arayüzde "Giriş Yap" olarak geçiyor; test bu butona göre yeniden yazıldı',
    before: "fill role=textbox[name=\"E-posta\"] · click text='Log in'",
    after: 'fill role=textbox[name="E-posta"] · click role=button[name="Giriş Yap"]',
  },
};
