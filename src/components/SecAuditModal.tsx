import type { SecAuditReport } from '../types';
import { X, Wrench, FileCode2, Package } from 'lucide-react';
import { ScoreRing, SEVERITY_TR, scoreGrade } from './TrAuditModal';

export function SecAuditModal({ report, onClose }: { report: SecAuditReport; onClose: () => void }) {
  const grade = scoreGrade(report.score);
  const total = report.items.reduce((n, it) => n + it.count, 0);
  const deps = report.dependencies;
  const restricted = !report.verified;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal tr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="sev tr">🛡️ GÜVENLİK TARAYICISI · pasif statik analiz</div>
          <button className="icon-btn" onClick={onClose} aria-label="Kapat">
            <X size={16} />
          </button>
        </div>

        <div className="tr-hero">
          <ScoreRing score={report.score} />
          <div>
            <h2>
              Güvenlik skoru: {report.score}/100 — <span className={`grade ${grade.cls}`}>{grade.label}</span>
            </h2>
            <p className="muted">
              {report.filesScanned} kaynak dosya okundu · {report.items.length} risk türü · {total} konum. Hiçbir canlı sisteme
              istek veya saldırı yapılmadı; bulunan gizli değerler maskelendi. Bağımlılıklar yalnızca açık OSV.dev veritabanıyla
              karşılaştırıldı.
            </p>
            {report.aiReview && (
              <p className="muted">
                🤖 Yapay zeka incelemesi ({report.aiReview.model}): {report.aiReview.checked} bulguya çevresindeki koda bakılarak
                bakıldı, {report.aiReview.falsePositives} tanesi yanlış alarm diye ayıklandı. Karar her bulgunun yanında yazıyor;
                "emin değilim" olanlar skora dahildir.
              </p>
            )}
          </div>
        </div>

        <div className="tr-item low">
          <div className="tr-item-head">
            <b>⚠️ Geliştirme aşamasında (beta)</b>
          </div>
          <p className="tr-why">
            Güvenlik Tarayıcısı henüz geliştirme aşamasındadır. Sonuçlar bir güvenlik denetiminin yerini tutmaz; "bulgu yok" demek
            "güvenli" demek değildir. Kaçırılan açıklar ve yanlış alarmlar olabilir.
          </p>
        </div>

        {restricted && report.verify && (
          <div className="tr-item medium">
            <div className="tr-item-head">
              <b>🔒 Kısıtlı rapor — repo sahibi doğrulanmadı</b>
            </div>
            <p className="tr-why">
              Başkasının kodundaki zayıf noktaların haritası çıkarılmasın diye dosya adı, satır, kod ve paket adları gizlendi; yalnızca risk
              türleri ve sayıları görünür. Bu repo sizinse, deponun ana dizinine <code>{report.verify.file}</code> adlı bir dosya ekleyin
              (içeriği aşağıdaki satır), commit'leyin ve taramayı yeniden çalıştırın.
            </p>
            <div className="tr-locs">
              <div className="tr-loc">
                <code>{report.verify.content}</code>
              </div>
            </div>
          </div>
        )}

        {report.items.length === 0 && <div className="tr-empty">Kod taramasında bilinen bir risk kalıbı bulunamadı.</div>}

        <div className="tr-items">
          {report.items.map((it) => (
            <div key={it.id} className={`tr-item ${it.severity}`} style={it.count === 0 ? { opacity: 0.55 } : undefined}>
              <div className="tr-item-head">
                <span className={`tr-sev ${it.severity}`}>{SEVERITY_TR[it.severity]}</span>
                <b>{it.title}</b>
                <span className="muted">{it.cwe}</span>
                <span className="muted right">{it.count === 0 ? 'hepsi yanlış alarm' : `×${it.count}`}</span>
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
                      {l.verdict && (
                        <span className="muted" title={l.reason}>
                          {l.verdict === 'real' ? '✅ gerçek' : l.verdict === 'false_positive' ? '❎ yanlış alarm' : '❓ emin değil'}
                          {l.reason ? ` — ${l.reason}` : ''}
                        </span>
                      )}
                    </div>
                  ))}
                  {it.count > it.locations.filter((l) => l.verdict !== 'false_positive').length && it.count > it.locations.length && (
                    <div className="tr-more">+{it.count - it.locations.length} konum daha</div>
                  )}
                </div>
              )}
              <div className="tr-fix">
                <Wrench size={12} /> <span>Öneri:</span> <code>{it.fix}</code>
              </div>
            </div>
          ))}

          {restricted && report.dependencyCount !== undefined && report.dependencyCount > 0 && (
            <div className="tr-item high">
              <div className="tr-item-head">
                <span className="tr-sev high">Yüksek</span>
                <Package size={13} /> <b>Bilinen açığı olan bağımlılıklar</b>
                <span className="muted right">×{report.dependencyCount}</span>
              </div>
              <p className="tr-why">Paket adları ve sürümleri doğrulanmamış repolarda gizlenir.</p>
            </div>
          )}
          {!restricted && deps === undefined && (
            <div className="tr-item low">
              <div className="tr-item-head">
                <Package size={13} /> <b>Bağımlılık kontrolü yapılamadı</b>
              </div>
              <p className="tr-why">
                package-lock.json bulunamadı ya da OSV.dev'e ulaşılamadı. Yerelde <code>npm audit</code> çalıştırın.
              </p>
            </div>
          )}
          {deps && deps.length > 0 && (
            <div className="tr-item high">
              <div className="tr-item-head">
                <span className="tr-sev high">Yüksek</span>
                <Package size={13} /> <b>Bilinen açığı olan bağımlılıklar</b>
                <span className="muted right">×{deps.length}</span>
              </div>
              <div className="tr-locs">
                {deps.map((d) => (
                  <div key={d.name} className="tr-loc">
                    <span className="tr-loc-file">
                      {d.name}@{d.version}
                    </span>
                    <code>{d.ids.join(', ')}</code>
                  </div>
                ))}
              </div>
              <div className="tr-fix">
                <Wrench size={12} /> <span>Öneri:</span> <code>npm audit fix</code> ya da paketleri güvenli sürüme yükseltin.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
