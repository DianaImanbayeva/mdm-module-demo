import React, { useEffect, useState } from 'react';
import { X, GitMerge, Check, Info } from 'lucide-react';
import api from '../api';
import { pickTranslatedName, localeFor } from '../i18n';

function goldenDisplayName(g, lang) {
  return pickTranslatedName(g.normalized_name, g.translations, lang);
}

const btnPrimary = { padding: '9px 16px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '8px', fontWeight: '700', fontSize: '13px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px' };
const btnGhost = { padding: '9px 16px', background: 'white', color: '#475569', border: '1px solid #cbd5e1', borderRadius: '8px', fontWeight: '700', fontSize: '13px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px' };

export default function RequestDetail({ id, lang, t, isSteward, entityTypes, onClose, onResolved }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showMetricInfo, setShowMetricInfo] = useState(false);

  const load = () => {
    setLoading(true);
    api.get(`/requests/${id}`)
      .then(res => setData(res.data))
      .catch(err => console.error(err))
      .finally(() => setLoading(false));
  };
  useEffect(load, [id]);

  const resolve = async (action, goldenId) => {
    try {
      await api.post(`/requests/${id}/resolve`, { action, golden_id: goldenId });
      onResolved?.();
      load();
    } catch (err) {
      alert(t('resolveErrorPrefix') + (err.response?.data?.error || err.message));
    }
  };

  const name = data ? pickTranslatedName(data.raw_name, data.translations, lang) : '';
  const entityLabel = data ? (entityTypes.find(e => e.value === data.entity_type)?.label || data.entity_type) : '';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: 'white', borderRadius: '16px', padding: '26px 28px', width: '660px', maxWidth: '92vw', maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '18px' }}>
          <div>
            <div style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 700 }}>{t('reqDetailLabel')}</div>
            <div style={{ fontSize: '12px', color: '#64748b', fontFamily: 'monospace' }}>{id}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8' }}><X size={18} /></button>
        </div>

        {loading && <p style={{ color: '#94a3b8' }}>{t('loading')}</p>}

        {data && (
          <>
            <h3 style={{ margin: '0 0 14px', fontSize: '17px', fontWeight: 800 }}>{name}</h3>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '18px', fontSize: '13px' }}>
              <div><span style={{ color: '#94a3b8' }}>{t('fieldSource')}: </span>{data.source_system}</div>
              <div><span style={{ color: '#94a3b8' }}>{t('fieldSubmittedBy')}: </span>{data.submitted_by || '—'}</div>
              <div><span style={{ color: '#94a3b8' }}>{t('fieldEntityType')}: </span>{entityLabel}</div>
              <div><span style={{ color: '#94a3b8' }}>{t('fieldCreatedAt')}: </span>{new Date(data.created_at).toLocaleString(localeFor(lang))}</div>
              {data.local_id && <div style={{ gridColumn: '1 / -1' }}><span style={{ color: '#94a3b8' }}>{t('fieldLocalId')}: </span><span style={{ fontFamily: 'monospace', fontSize: '12px' }}>{data.local_id}</span></div>}
            </div>

            <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', fontWeight: '700', marginBottom: '8px' }}>{t('enteredAttributesTitle')}</div>
            <div style={{ marginBottom: '18px', padding: '12px 14px', background: '#f8fafc', borderRadius: '8px', fontSize: '13px' }}>
              <div><span style={{ color: '#94a3b8' }}>{t('fieldNameAsEntered')}: </span>{name}</div>
              {data.raw_attributes?.article && <div><span style={{ color: '#94a3b8' }}>{t('fieldArticle')}: </span>{data.raw_attributes.article}</div>}
              {data.raw_attributes?.unit && <div><span style={{ color: '#94a3b8' }}>{t('fieldUnitCode')}: </span>{data.raw_attributes.unit}</div>}
              {!data.raw_attributes?.article && !data.raw_attributes?.unit && (
                <div style={{ color: '#94a3b8' }}>{t('noOtherFieldsPassed')}</div>
              )}
            </div>

            {data.golden && (
              <div style={{ marginBottom: '18px', padding: '12px 14px', background: '#eff6ff', borderRadius: '8px', fontSize: '13px' }}>
                <div style={{ fontSize: '11px', color: '#1d4ed8', textTransform: 'uppercase', fontWeight: '700', marginBottom: '4px' }}>{t('linkedGoldenTitle')}</div>
                <div style={{ fontWeight: 700 }}>{goldenDisplayName(data.golden, lang)}</div>
                <div style={{ color: '#64748b', fontSize: '12px' }}>{data.resolved_by} · {data.resolved_at && new Date(data.resolved_at).toLocaleString(localeFor(lang))}</div>
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px' }}>
              <span style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', fontWeight: '700' }}>{t('matchWithGoldenTitle')}</span>
              <button onClick={() => setShowMetricInfo(v => !v)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', display: 'flex' }} title={t('metricInfoBtn')}>
                <Info size={14} />
              </button>
            </div>
            {showMetricInfo && (
              <div style={{ marginBottom: '12px', padding: '10px 12px', background: '#fef9c3', borderRadius: '8px', fontSize: '12px', color: '#713f12', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div>{t('metricPgTrgm')}</div>
                <div>{t('metricLevenshtein')}</div>
                <div>{t('metricJaroWinkler')}</div>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '18px' }}>
              {(data.candidates || []).map(c => (
                <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', border: '1px solid #e2e8f0', borderRadius: '8px' }}>
                  <div>
                    <div style={{ fontWeight: '600', fontSize: '13.5px' }}>{goldenDisplayName(c, lang)}</div>
                    <div style={{ fontSize: '12px', color: '#94a3b8' }}>
                      pg_trgm {(c.score * 100).toFixed(0)}%
                      {c.levenshtein_score != null && <> · LEV {(c.levenshtein_score * 100).toFixed(0)}%</>}
                      {c.jaro_winkler_score != null && <> · JW {(c.jaro_winkler_score * 100).toFixed(0)}%</>}
                    </div>
                  </div>
                  {data.status === 'conflict' && isSteward && (
                    <button style={btnPrimary} onClick={() => resolve('merge', c.id)}>
                      <GitMerge size={14} /> {t('mergeBtn')}
                    </button>
                  )}
                </div>
              ))}
              {(!data.candidates || data.candidates.length === 0) && (
                <div style={{ color: '#94a3b8', fontSize: '13px' }}>{t('noCandidates')}</div>
              )}
            </div>

            {data.status === 'conflict' && isSteward && (
              <button style={{ ...btnGhost, width: '100%', justifyContent: 'center' }} onClick={() => resolve('create_new')}>
                <Check size={14} /> {t('noneMatchCreateNew')}
              </button>
            )}
            {data.status === 'conflict' && !isSteward && (
              <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>{t('waitingSteward')}</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
