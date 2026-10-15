# Canary TR — Türkiye için yapay zeka QA mühendisi

> Y Combinator **W26** girişimi **[Canary](https://www.ycombinator.com/companies/canary)**'nin ("kodunuzu anlayan ilk
> yapay zeka QA mühendisi") çalışan bir klonu ve Türkiye'ye uyarlanmış, yenilik eklenmiş versiyonu.

Canary TR bir GitHub reposunu okur, kritik kullanıcı akışlarını yapay zekayla çıkarır, her akış için **Playwright**
uçtan uca testleri yazıp **gerçek bir tarayıcıda** çalıştırır; bir test başarısız olursa hatayı **dosya, satır ve
commit** seviyesine kadar izler ve bir düzeltme önerir.

## Neden? ("teknolojik deprem")

Yapay zeka kod araçları geliştirmeyi hızlandırdı, ama test etme aynı hızda kalmadı. Canary'nin deyişiyle:
*"Kod üretimi çözülmüş bir problem. Kod doğrulama değil."* Canary bu darboğazı, kodun niyetini okuyup testleri
kendisi yazarak çözmeyi hedefliyor.

## Klon: Canary'nin döngüsü (çalışıyor)

1. **Kodu okur** — repo `git clone` ile alınır, rotalar / sayfalar / API dosyaları seçilir.
2. **Akışları çıkarır** — Gemini kayıt, giriş, sepet, ödeme gibi kritik akışları bulur.
3. **Testleri yazar** — her akış için Playwright adımları üretilir (`server/generated-tests/*.spec.ts`).
4. **Tarayıcıda koşar** — headless Chromium, her adımda **gerçek ekran görüntüsü**.
5. **Hatayı açıklar** — dosya:satır, commit, kısa açıklama ve tek satırlık düzeltme önerisi.

## Yenilikler (orijinal Canary'de yok)

| Yenilik | Ne yapıyor? |
| --- | --- |
| 🩹 **Kendini onaran testler** | Üretilen test bir adımda düşerse Canary sayfanın **o anki gerçek halini** (erişilebilirlik ağacı) okur, adımı gerçek öğelere göre yeniden yazar ve **hemen tekrar çalıştırır**. Geçerse test kendini onarmış olur (kırmızı → yeşil) ve onarılmış test dosyaya kaydedilir; hiçbir öğe hedefe uymuyorsa bu, gerçek bir uygulama hatasının kanıtıdır. |
| 🧪 **Hata mı, test mi?** | Yapay zeka bir başarısızlığın **uygulamadan** mı yoksa **kendi yazdığı testten** mi kaynaklandığına karar verir. Test sorunuysa uydurma bir düzeltme önermez, "uygulamada değişiklik gerekmiyor" der. |
| 🇹🇷 **Türkiye profili** | Testler **tr-TR** dilinde ve **İstanbul** saat diliminde koşar. Yapay zeka Türkiye'ye özel akışlar ekler (İ/ı, ₺ ve "1.249,90" biçimi, TC Kimlik, `TR` IBAN, `+90`, KVKK) ve bunları 🇹🇷 ile işaretler. Analizler **Türkçe**. |
| 🇹🇷 **Türkiye Uyum Tarayıcısı** | **Yapay zeka kullanmadan** tüm kodu tarar ve **0–100 uyum skoru** verir: yerel belirtilmeden `toUpperCase()/toLowerCase()`, `Number("1.249,90")`, `toISOString()` ile UTC gün hesabı, `$` / `en-US` biçimi, dil verilmemiş tarih, KVKK bilgilendirmesi eksikliği. Bulgular yapay zekaya ipucu olarak da verilir. |
| ⚠️ **Dürüst raporlama** | Gemini kotası dolarsa, repo klonlanamazsa ya da tarayıcı açılmazsa sistem çökmez; **"Kısmi tarama — sonuçlar eksik olabilir"** der ve asla "güvenli" demez. |
| 🎬 **Sahne modu** | İnternet ve yapay zeka gerektirmeden kayıtlı bir taramayı oynatır (sunum güvenliği). |

### 🛡️ Güvenlik Tarayıcısı — ⚠️ geliştirme aşamasında (beta)

> **Bu özellik henüz geliştirme aşamasındadır.** Sonuçlar bir güvenlik denetiminin yerini **tutmaz**; "bulgu yok"
> demek "güvenli" demek değildir. Kaçırdığı açıklar ve yanlış alarmlar olabilir.

Seçmeli ve **pasif** bir statik analizdir: yalnızca kaynak kodu okur, canlı sisteme istek veya saldırı yapmaz.

- **Kural tabanlı tarama:** gömülü anahtarlar, `eval`, XSS, SQL/NoSQL enjeksiyonu, komut enjeksiyonu, açık yönlendirme,
  zayıf TLS/CORS/özet algoritması, çerez bayrakları, eksik CSRF/helmet, commit'lenmiş `.env`/özel anahtar dosyaları.
- **Bağımlılık kontrolü:** `package-lock.json` yalnızca paket adı + sürümle [OSV.dev](https://osv.dev)'e sorulur.
- **Yapay zeka ikinci görüşü:** Gemini her bulguya çevresindeki koda bakarak *gerçek / yanlış alarm / emin değil* der.
  Gizli değerler maskelenip gönderilir; yapay zeka bulgu **ekleyemez**, yalnızca yanlış alarm olarak işaretleyebilir.
- **Etik ve yasal tasarım:** tarama için "kodun sahibiyim / iznim var" onayı gerekir. Repo sahibi `.canary-verify`
  dosyasıyla sahipliğini kanıtlamadıkça rapor **kısıtlıdır** (dosya, satır, kod ve paket adı gösterilmez). Tarama kaydı
  kod içermez, IP adresi tuzlanmış özet olarak tutulur ve 30 gün sonra silinir.
- **Bilinen sınırlar:** satır satır kurallar veri akışını izlemez (örn. `const x = req.query.a; res.redirect(x)`
  yakalanmaz); yalnızca JS/TS taranır; kural ölçümü kendi yazdığımız 67 testle yapılmıştır, gerçek dünya oranı değildir.
- **Doğrulama:** [OWASP NodeGoat](https://github.com/OWASP/NodeGoat) üzerinde bilinen açıkların (eval, `$where`, açık
  yönlendirme, gömülü sırlar) bulunduğu görüldü; Semgrep ile karşılaştırıldı ve ikisi birbirini tamamlıyor.

Çalıştırmak için: `cd server && npm test` (kural testleri) ve tarama isteğinde `{ "security": true, "authorized": true }`.

### Gerçek sonuç: Synaptix (ekibimizin projesi)

Türkiye Uyum Tarayıcısı, ekibimizin React projesi [Synaptix](https://github.com/emirhnnd/lumosity-brain-lab)'i
**58/100** buldu:

- **Kelime Balonları** oyununda `input.trim().toLowerCase()` — oyuncu "IŞIK" yazarsa kod `"işik"` üretir
  (doğrusu `"ışık"`), doğru kelime reddedilir.
- **Seri sistemi**nde `new Date().toISOString().split('T')[0]` — Türkiye UTC+3 olduğu için gece 00:00–03:00
  arası oynanan gün bir önceki güne yazılır.
- Profil verisi `localStorage`'da saklanıyor ama **KVKK / çerez bilgilendirmesi** yok.

Kendini onaran testler de Synaptix'te doğdu: yapay zekanın yazdığı test İngilizce varsayımla **"Dashboard"**
butonu aradı, arayüzde buton **"Ana Panel"**. Canary TR artık bunu fark edip testi kendisi düzeltiyor.

### Sahne senaryosu: "Çarşı" (hayali mağaza)

Ürün API'si fiyatları `"1.249,90"` biçiminde döndürmeye başlamış, `lib/fiyat.ts` hâlâ `Number(u.fiyat)` kullanıyor →
sepet toplamı **"NaN ₺"**, "Siparişi Onayla" kilitli. İngilizce yerelde koşan testler bunu yakalayamaz.

## Mimari

```
React + Vite arayüz ──POST /api/scans──▶ Express + TypeScript backend
        ▲                                   │ 1. git clone (simple-git)
        └────── Server-Sent Events ─────────┤ 2. 🇹🇷 Türkiye Uyum Tarayıcısı (statik, yapay zekasız)
                                            │ 3. Gemini: akışları çıkar (Türkiye profili + tarayıcı ipuçları)
                                            │ 4. Gemini: Playwright testlerini yaz (tek istek)
                                            │ 5. Playwright/Chromium (tr-TR, Europe/Istanbul) + ekran görüntüleri
                                            │ 6. 🩹 Düşen adımı gerçek sayfaya göre onar ve tekrar koş
                                            │ 7. Gemini: kök neden + "hata mı, test mi?"
```

| Klasör / dosya | İçerik |
| --- | --- |
| `src/` | Arayüz (React + Vite + TypeScript) |
| `src/scenario.ts` | Sahne modu senaryosu ("Çarşı") |
| `server/src/scanner.ts` | Tarama hattı |
| `server/src/trAudit.ts` | Türkiye Uyum Tarayıcısı |
| `server/src/heal.ts` | Kendini onaran testler |
| `server/src/profile.ts` | Türkiye profili (tarayıcı yereli, yapay zeka talimatları) |
| `server/src/failure.ts` | Kök neden analizi, "hata mı, test mi?" |
| `server/src/gemini.ts` | Gemini istemcisi (yedek modeller, kota/yoğunluk yönetimi) |

## Çalıştırma

Gerekenler: **Node.js 20+**, **Git**, bir **Gemini API anahtarı** (canlı mod için).

```powershell
npm install
cd server
npm install
npx playwright install chromium
Copy-Item .env.example .env   # GEMINI_API_KEY=... yazın
cd ..
Set-Content .env.local "VITE_API_URL=http://localhost:8787"
```

Windows'ta en kolayı:

- **`baslat.bat`** — canlı mod: gerçek klon + Gemini + Chromium.
- **`baslat-sahne.bat`** — sahne modu: internet ve Gemini gerektirmez.

Elle: backend için `cd server && npm run dev` (ya da `npm run dev:scripted`), arayüz için ayrı bir pencerede
`npm run dev`. Ayrıntılar: [server/README.md](server/README.md).

`server/.env` örneği:

```
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.7-flash
GEMINI_FALLBACK_MODEL=gemini-3.5-flash,gemini-3.6-flash,gemini-flash-latest,gemini-3.1-flash-lite,gemini-3.8-flash
GEMINI_TIMEOUT_MS=90000
```

## Neler gerçek, neler temsili

- **Gerçek:** repo klonlama, Türkiye uyum taraması, yapay zeka ile akış ve test üretimi, tr-TR Chromium'da test,
  ekran görüntüleri, kendini onaran testler, kök neden analizi.
- **Temsili:** "Düzeltme PR'ı aç" düğmesi (animasyon); sahne modundaki "Çarşı" mağazası (hayali); tarama elle
  başlatılıyor, GitHub/CI entegrasyonu yok.
- **Sınırlar:** ücretsiz Gemini kotası model başına günde ~20 istek; bir tarama yaklaşık 2–6 istek harcar.

## Kaynaklar

- [Canary — Y Combinator şirket sayfası](https://www.ycombinator.com/companies/canary)
- [Canary — Launch YC tanıtımı](https://www.ycombinator.com/launches/PSs-canary-the-first-ai-qa-engineer-that-understands-your-codebase)
- [T.C. Ticaret Bakanlığı — Türkiye'de e-ticaret 2025](https://ticaret.gov.tr/haberler/turkiyede-e-ticaret-hacmi-2025te-4-6-trilyon-liraya-ulasti)
