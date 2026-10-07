import type { TrAuditReport, TrSeverity } from '../types';
import { X, Wrench, FileCode2 } from 'lucide-react';

export const SEVERITY_TR: Record<TrSeverity, string> = { critical: 'Kritik', high: 'Yüksek', medium: 'Orta', low: 'Düşük' };

export function scoreGrade(score: number): { label: string; cls: string } {
  if (score >= 85) return { label: 'İyi', cls: 'good' };
  if (score >= 60) return { label: 'Orta', cls: 'mid' };
  return { label: 'Riskli', cls: 'bad' };
}

/** Circular score gauge. Color also carried by the grade word next to it. */
export function ScoreRing({ score, size = 120 }: { score: number; size?: number }) {
  const r = size / 2 - 10;
  const c = 2 * Math.PI * r;
  const { cls } = scoreGrade(score);
  return (
    <svg className={`score-ring ${cls}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-label={`Türkiye uyum skoru ${score}/100`}>
      <circle cx={size / 2} cy={size / 2} r={r} className="track" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        className="value"
        strokeDasharray={`${(c * score) / 100} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="num">
        {score}
      </text>
    </svg>
  );
}

export function TrAuditModal({ report, onClose }: { report: TrAuditReport; onClose: () => void }) {
  const grade = scoreGrade(report.score);
  const total = report.items.reduce((n, it) => n + it.count, 0);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal tr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="sev tr">🇹🇷 TÜRKİYE UYUM TARAYICISI · yapay zeka kullanmaz</div>
          <button className="icon-btn" onClick={onClose} aria-label="Kapat">
            <X size={16} />
          </button>
        </div>

        <div className="tr-hero">
          <ScoreRing score={report.score} />
          <div>
            <h2>
              Türkiye uyum skoru: {report.score}/100 — <span className={`grade ${grade.cls}`}>{grade.label}</span>
            </h2>
            <p className="muted">
              {report.filesScanned} kaynak dosya tarandı · {report.items.length} risk türü · {total} konum. Bu kalıplar
              geliştiricinin İngilizce bilgisayarında sorunsuz çalışır, hata yalnızca Türkiye'deki kullanıcıda ortaya çıkar.
            </p>
          </div>
        </div>

        {report.items.length === 0 && (
          <div className="tr-empty">Türkiye'ye özel risk bulunamadı. İ/ı, ₺, tarih ve KVKK kontrollerinin hepsi temiz.</div>
        )}

        <div className="tr-items">
          {report.items.map((it) => (
            <div key={it.id} className={`tr-item ${it.severity}`}>
              <div className="tr-item-head">
                <span className={`tr-sev ${it.severity}`}>{SEVERITY_TR[it.severity]}</span>
                <b>{it.title}</b>
                <span className="muted right">×{it.count}</span>
              </div>
              <p className="tr-why">{it.why}</p>
              {it.locations.length > 0 && (
                <div className="tr-locs">
                  {it.locations.map((l) => (
                    <div key={`${l.file}:${l.line}`} className="tr-loc">
                      <span className="tr-loc-file" title={`${l.file}:${l.line}`}>
                        <FileCode2 size={11} /> {l.file.split('/').pop()}:{l.line}
                      </span>
                      <code>{l.text}</code>
                    </div>
                  ))}
                  {it.count > it.locations.length && (
                    <div className="tr-more">+{it.count - it.locations.length} konum daha</div>
                  )}
                </div>
              )}
              <div className="tr-fix">
                <Wrench size={12} /> <span>Öneri:</span> <code>{it.fix}</code>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
