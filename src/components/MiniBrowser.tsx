import type { View } from '../types';
import { Lock, ShoppingBag, Search, User, Tag, CheckCircle2 } from 'lucide-react';

interface Props {
  url: string;
  view: View | null;
  target?: string;
  failed?: boolean;
  idle?: boolean;
  /** Real Playwright screenshot (live mode). When set, it replaces the mock page. */
  shot?: string;
  /** Real page URL shown in the address bar together with `shot`. */
  pageUrl?: string;
  /** Host of the app under test (from the App URL box); used before any screenshot arrives. */
  host?: string;
}

function displayUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname}${x.search}`;
  } catch {
    return u;
  }
}

export function MiniBrowser({ url, view, target, failed, idle, shot, pageUrl, host = 'staging.carsi.dev' }: Props) {
  const hl = (id: string) => (target === id ? (failed ? 'hl hl-fail' : 'hl') : '');

  return (
    <div className="browser">
      <div className="browser-bar">
        <span className="dot r" />
        <span className="dot y" />
        <span className="dot g" />
        <div className="browser-url">
          <Lock size={11} />
          <span>{pageUrl ? displayUrl(pageUrl) : `${host}${url}`}</span>
        </div>
        <span className="browser-tag">{idle ? 'boşta' : 'chromium · headless'}</span>
      </div>
      <div className="browser-body">
        {shot ? (
          <div className={`browser-shot ${failed ? 'failed' : ''}`}>
            <img src={shot} alt="Canary'nin tarayıcısının çektiği ekran görüntüsü" />
          </div>
        ) : idle || !view ? (
          <div className="browser-idle">
            <div className="pulse-ring" />
            <span>Testler bekleniyor…</span>
          </div>
        ) : (
          <Page view={view} hl={hl} />
        )}
      </div>
    </div>
  );
}

function ShopHeader({ hl }: { hl: (id: string) => string }) {
  return (
    <div className="sp-header">
      <span className="sp-logo">
        <ShoppingBag size={14} /> çarşı
      </span>
      <div className={`sp-search ${hl('search')}`}>
        <Search size={11} /> kışlık bot
      </div>
      <span className={`sp-avatar ${hl('avatar')}`}>
        <User size={12} />
      </span>
    </div>
  );
}

function Page({ view, hl }: { view: View; hl: (id: string) => string }) {
  switch (view) {
    case 'signup':
    case 'login':
    case 'reset':
      return (
        <div className="sp-auth">
          <div className="sp-card">
            <h4>{view === 'signup' ? 'Hesabını oluştur' : view === 'login' ? 'Tekrar hoş geldin' : 'Şifreni sıfırla'}</h4>
            <label>E-posta</label>
            <div className={`sp-input ${hl('email')}`}>ayse.yilmaz+canary@ornek.com.tr</div>
            {view !== 'reset' && (
              <>
                <label>Şifre</label>
                <div className="sp-input">••••••••••</div>
              </>
            )}
            <div className={`sp-btn ${hl('submit')}`}>
              {view === 'signup' ? 'Hesap Oluştur' : view === 'login' ? 'Giriş Yap' : 'Bağlantı Gönder'}
            </div>
            {view === 'reset' && (
              <div className={`sp-toast ${hl('toast')}`}>
                <CheckCircle2 size={12} /> Gelen kutunu kontrol et
              </div>
            )}
          </div>
        </div>
      );
    case 'search':
      return (
        <>
          <ShopHeader hl={hl} />
          <div className="sp-search-page">
            <div className={`sp-filters ${hl('filter')}`}>
              <b>Numara</b>
              <span>40</span>
              <span>41</span>
              <span className="on">42</span>
              <span>43</span>
            </div>
            <div className="sp-grid">
              {['Kışlık Bot Pro', 'Şehir Bot 2', 'Kar Botu', 'Patika X'].map((n, i) => (
                <div key={n} className="sp-prod">
                  <div className={`sp-img c${i}`} />
                  <span>{n}</span>
                  <b>{(1249.9 + i * 150).toLocaleString('tr-TR', { minimumFractionDigits: 2 })} ₺</b>
                </div>
              ))}
            </div>
          </div>
        </>
      );
    case 'product':
      return (
        <>
          <ShopHeader hl={hl} />
          <div className="sp-pdp">
            <div className="sp-img big c0" />
            <div>
              <h4>Kışlık Bot Pro</h4>
              <p className="muted">Su geçirmez, hafif kışlık bot</p>
              <b className="price">1.249,90 ₺</b>
              <div className={`sp-btn ${hl('add')}`}>Sepete Ekle</div>
            </div>
          </div>
        </>
      );
    case 'cart':
      return (
        <>
          <ShopHeader hl={hl} />
          <div className="sp-cart">
            <h4>Sepetim (1)</h4>
            <div className={`sp-line ${hl('line')}`}>
              <div className="sp-img sm c0" />
              <span>Kışlık Bot Pro · 42 numara</span>
              <b>1.249,90 ₺</b>
            </div>
          </div>
        </>
      );
    case 'checkout':
    case 'checkout-error': {
      const err = view === 'checkout-error';
      return (
        <>
          <ShopHeader hl={hl} />
          <div className="sp-checkout">
            <h4>Ödeme</h4>
            <div className="sp-line">
              <div className="sp-img sm c0" />
              <span>Kışlık Bot Pro × 1</span>
              <b>1.249,90 ₺</b>
            </div>
            <div className={`sp-coupon ${hl('coupon')}`}>
              <Tag size={11} /> {err ? 'İNDİRİM100' : 'Kupon kodu'}
              {err && <span className="applied">uygulandı</span>}
            </div>
            <div className="sp-row">
              <span>Ara toplam</span>
              <span>1.249,90 ₺</span>
            </div>
            {err && (
              <div className="sp-row">
                <span>Kupon</span>
                <span>−100,00 ₺</span>
              </div>
            )}
            <div className={`sp-row total ${hl('total')} ${err ? 'nan' : ''}`}>
              <span>Toplam</span>
              <span>{err ? 'NaN ₺' : '1.249,90 ₺'}</span>
            </div>
            <div className={`sp-btn ${err ? 'disabled' : ''} ${hl('pay')}`}>Siparişi Onayla</div>
          </div>
        </>
      );
    }
    case 'orders':
      return (
        <>
          <ShopHeader hl={hl} />
          <div className="sp-cart">
            <h4>Siparişlerim</h4>
            <div className={hl('rows')}>
              {['#1042 · 03.10.2026 · Teslim edildi', '#1031 · 21.09.2026 · Teslim edildi', '#1018 · 02.09.2026 · İade edildi'].map((o) => (
                <div key={o} className="sp-line">
                  <div className="sp-img sm c2" />
                  <span>{o}</span>
                  <b>1.399,90 ₺</b>
                </div>
              ))}
            </div>
          </div>
        </>
      );
  }
}
