import React, { useEffect, useState } from 'react';
import { X, Tag, History, ScrollText, Trash2 } from 'lucide-react';
import api from '../api';
import { pickTranslatedName, localeFor, format } from '../i18n';

export default function GoldenRecordDetail({ id, lang, t, isSteward, onClose, onDeleted }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get(`/golden-records/${id}`)
      .then(res => setData(res.data))
      .catch(err => console.error(err))
      .finally(() => setLoading(false));
  }, [id]);

  const handleDelete = async () => {
    if (!window.confirm(format(t('confirmDeleteGolden'), { name: data?.normalized_name }))) return;
    setDeleting(true);
    try {
      await api.delete(`/golden-records/${id}`);
      onDeleted?.();
      onClose();
    } catch (err) {
      alert(t('deleteErrorPrefix') + (err.response?.data?.error || err.message));
    } finally {
      setDeleting(false);
    }
  };

  const name = data ? pickTranslatedName(data.normalized_name, data.translations, lang) : '';
  const unit = data ? (data.base_unit ? pickTranslatedName(data.base_unit, data.unit_translations, lang) : '—') : '—';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: 'white', borderRadius: '16px', padding: '26px 28px', width: '620px', maxWidth: '92vw', maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '18px' }}>
          <div>
            <div style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 700 }}>{t('globalGuid')}</div>
            <div style={{ fontSize: '12px', color: '#64748b', fontFamily: 'monospace' }}>{id}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {isSteward && (
              <button
                onClick={handleDelete}
                disabled={deleting || loading}
                title={t('deleteGoldenTitle')}
                style={{ display: 'flex', alignItems: 'center', gap: '5px', background: 'none', border: '1px solid #fecaca', color: '#ef4444', borderRadius: '7px', padding: '5px 10px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
              >
                <Trash2 size={13} /> {t('deleteGoldenBtn')}
              </button>
            )}
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8' }}><X size={18} /></button>
          </div>
        </div>

        {loading && <p style={{ color: '#94a3b8' }}>{t('loading')}</p>}

        {data && (
          <>
            <h3 style={{ margin: '0 0 14px', fontSize: '17px', fontWeight: 800 }}>{name}</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '22px', fontSize: '13px' }}>
              <div><span style={{ color: '#94a3b8' }}>{t('fieldArticle')}: </span>{data.article || '—'}</div>
              <div><span style={{ color: '#94a3b8' }}>{t('fieldMaterialGroup')}: </span>{data.material_group || '—'}</div>
              <div><span style={{ color: '#94a3b8' }}>{t('fieldBaseUnit')}: </span>{unit}</div>
              <div><span style={{ color: '#94a3b8' }}>{t('colCreated')}: </span>{new Date(data.created_at).toLocaleString(localeFor(lang))}</div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: '10px' }}>
              <Tag size={13} /> {t('crossRefTitle')}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '22px' }}>
              {data.crossReferences.length === 0 && <span style={{ color: '#94a3b8', fontSize: '13px' }}>{t('crossRefEmpty')}</span>}
              {data.crossReferences.map((cr, i) => (
                <span key={i} style={{ padding: '5px 10px', borderRadius: '999px', background: '#eff6ff', color: '#1d4ed8', fontSize: '12px', fontWeight: 700, fontFamily: 'monospace' }}>
                  {cr.system_code}: {cr.local_system_id}
                </span>
              ))}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: '10px' }}>
              <History size={13} /> {t('historyTitle')}
            </div>
            <div style={{ marginBottom: '22px' }}>
              {data.history.length === 0 && <span style={{ color: '#94a3b8', fontSize: '13px' }}>{t('historyEmpty')}</span>}
              {data.history.map(h => (
                <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid #f1f5f9', fontSize: '12.5px' }}>
                  <span>{h.source_system} · {pickTranslatedName(h.raw_name, h.translations, lang)}</span>
                  <span style={{ color: '#94a3b8' }}>{h.resolved_by || '—'} · {new Date(h.created_at).toLocaleDateString(localeFor(lang))}</span>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: '10px' }}>
              <ScrollText size={13} /> {t('auditTitle')}
            </div>
            <div>
              {data.auditLog.length === 0 && <span style={{ color: '#94a3b8', fontSize: '13px' }}>{t('auditEmpty')}</span>}
              {data.auditLog.map(a => (
                <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid #f1f5f9', fontSize: '12.5px' }}>
                  <span>{a.action} · {a.actor || 'system'}</span>
                  <span style={{ color: '#94a3b8' }}>{new Date(a.created_at).toLocaleString(localeFor(lang))}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
