import { useState } from 'react';
import type { Failure } from '../types';
import { MiniBrowser } from './MiniBrowser';
import { AlertTriangle, GitCommit, GitPullRequest, X, Sparkles, Check, FileCode2, FlaskConical, RefreshCw } from 'lucide-react';

/** Badge text + color. Scripted scenario has no `kind`/`severity`, so it keeps the original label. */
function badge(f: Failure): { text: string; cls: string; testIssue: boolean } {
  if (f.kind === 'test_issue') {
    return { text: 'TEST SORUNU · uygulama kodu doğru görünüyor', cls: 'sev warn', testIssue: true };
  }
  if (!f.severity) return { text: 'KRİTİK · ödemeyi engelliyor', cls: 'sev', testIssue: false };
  const sev = { critical: 'KRİTİK', high: 'YÜKSEK', medium: 'ORTA' }[f.severity];
  const where = f.flowName ? ` · “${f.flowName}” akışını bozuyor` : '';
  return { text: `${sev}${where}`, cls: f.severity === 'critical' ? 'sev' : `sev ${f.severity}`, testIssue: false };
}

export function FailureModal({ failure, onClose }: { failure: Failure; onClose: () => void }) {
  const [pr, setPr] = useState<'idle' | 'opening' | 'opened'>('idle');
  const b = badge(failure);

  const openPr = () => {
    setPr('opening');
    setTimeout(() => setPr('opened'), 1400);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className={b.cls}>
            {b.testIssue ? <FlaskConical size={14} /> : <AlertTriangle size={14} />} {b.text}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Kapat">
            <X size={16} />
          </button>
        </div>
        <h2>{failure.title}</h2>

        <div className="modal-grid">
          <div className="col">
            <div className="section-label">Kullanıcının gördüğü</div>
            {failure.screenshot ? (
              <MiniBrowser url="/" view={null} shot={failure.screenshot} pageUrl={failure.pageUrl} failed={!b.testIssue} />
            ) : (
              <MiniBrowser url="/odeme" view="checkout-error" target="total" failed />
            )}
            <div className="expect">
              <div>
                <span className="tag ok">beklenen</span>
                {failure.expected}
              </div>
              <div>
                <span className="tag bad">gerçekleşen</span>
                {failure.actual}
              </div>
            </div>
          </div>

          <div className="col">
            <div className="section-label">
              <FileCode2 size={12} /> {b.testIssue ? 'Kaynaktaki hedef öğe' : 'Kök neden'} · {failure.file}:{failure.line}
            </div>
            <pre className="code">
              {failure.code.map((l) => (
                <div key={l.n} className={l.bad ? 'bad' : ''}>
                  <span className="ln">{l.n}</span>
                  {l.text || ' '}
                </div>
              ))}
            </pre>

            <div className="commit">
              <GitCommit size={13} />
              <code>{failure.commit.sha}</code>
              <span>{failure.commit.message}</span>
              <span className="muted">
                · {failure.commit.author} · {failure.commit.when}
              </span>
            </div>

            <div className="explain">
              <div className="section-label">
                <Sparkles size={12} /> Canary analizi
              </div>
              <p>{failure.explanation}</p>
            </div>

            {b.testIssue ? (
              <div className="test-note">
                <RefreshCw size={14} />
                <span>
                  Uygulamanızda değişiklik gerekmiyor. Canary bunu kendi ürettiği testteki bir sorun olarak işaretledi;
                  PR açmak yerine bir sonraki çalıştırmada bu adımı yeniden yazacak.
                </span>
              </div>
            ) : (
              <>
                <div className="section-label">Önerilen düzeltme</div>
                <pre className="code diff">
                  <div className="del">- {failure.fix.before.trimStart()}</div>
                  <div className="add">+ {failure.fix.after.trimStart()}</div>
                </pre>

                <button className={`btn primary wide ${pr}`} onClick={openPr} disabled={pr !== 'idle'}>
                  {pr === 'idle' && (
                    <>
                      <GitPullRequest size={15} /> Düzeltme PR'ı aç
                    </>
                  )}
                  {pr === 'opening' && (
                    <>
                      <span className="spinner" /> Pull request açılıyor…
                    </>
                  )}
                  {pr === 'opened' && (
                    <>
                      <Check size={15} /> PR #128 açıldı · testler yeniden çalıştı, hepsi yeşil
                    </>
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
