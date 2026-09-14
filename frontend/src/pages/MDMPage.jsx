import React, { useState, useEffect, useCallback, useRef } from 'react';
import { LayoutDashboard, Inbox, Database, RefreshCw, Check, X, PlusCircle, Search, Radio, UploadCloud, Info } from 'lucide-react';
import api from '../api';
import GoldenRecordDetail from '../components/GoldenRecordDetail';
import RequestDetail from '../components/RequestDetail';
import { pickTranslatedName, localeFor, format } from '../i18n';

// Общий расчёт границ периода (за неделю/месяц/весь период/свой диапазон) —
// используется и на дашборде, и в "Заявках". Считается на каждый вызов
// (не на смену пресета), чтобы "за неделю" значило "последние 7 дней от
// сейчас", а не от момента выбора пресета.
function periodToRange(preset, customFrom, customTo) {
  if (preset === 'week' || preset === 'month') {
    const days = preset === 'week' ? 7 : 30;
    const from = new Date();
    from.setDate(from.getDate() - days);
    return { date_from: from.toISOString() };
  }
  if (preset === 'custom') {
    const range = {};
    if (customFrom) range.date_from = new Date(customFrom + 'T00:00:00').toISOString();
    if (customTo) range.date_to = new Date(customTo + 'T23:59:59').toISOString();
    return range;
  }
  return {};
}

function useDebounced(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}


const ENTITY_TYPE_KEYS = [
  { value: 'material', key: 'entityMaterial' },
  { value: 'labor', key: 'entityLabor' },
  { value: 'machine', key: 'entityMachine' },
  { value: 'job', key: 'entityJob' },
  { value: 'resource', key: 'entityResource' },
  { value: 'contractor', key: 'entityContractor' },
  { value: 'object', key: 'entityObject' },
  { value: 'employee', key: 'entityEmployee' },
];

const SOURCE_SYSTEM_KEYS = [
  { value: 'USP', key: 'sourceUsp' },
  { value: 'ERP_NSI', key: 'sourceErpNsi' },
];

const STATUS_KEYS = {
  new: 'statusNew',
  merged: 'statusMerged',
  created: 'statusCreated',
  conflict: 'statusConflict',
  rejected: 'statusRejected',
};
const STATUS_COLORS = {
  new: { bg: '#e2e8f0', color: '#475569' },
  merged: { bg: '#dcfce7', color: '#15803d' },
  created: { bg: '#dbeafe', color: '#1d4ed8' },
  conflict: { bg: '#fef3c7', color: '#92400e' },
  rejected: { bg: '#fee2e2', color: '#991b1b' },
};

function goldenName(g, lang) {
  return pickTranslatedName(g.normalized_name, g.translations, lang);
}

function goldenUnit(g, lang) {
  if (!g.base_unit) return '—';
  return pickTranslatedName(g.base_unit, g.unit_translations, lang);
}

function requestName(r, lang) {
  return pickTranslatedName(r.raw_name, r.translations, lang);
}

const card = { background: 'white', border: '1px solid #e2e8f0', borderRadius: '12px', boxShadow: '0 1px 2px rgba(15,23,42,0.04)' };
const btnPrimary = { padding: '9px 16px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '8px', fontWeight: '700', fontSize: '13px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px' };
const btnGhost = { padding: '9px 16px', background: 'white', color: '#475569', border: '1px solid #cbd5e1', borderRadius: '8px', fontWeight: '700', fontSize: '13px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px' };
const input = { width: '100%', padding: '9px 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '13px', outline: 'none' };
const label = { fontSize: '11px', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: '5px', display: 'block' };

function StatusBadge({ status, t }) {
  const colors = STATUS_COLORS[status] || { bg: '#e2e8f0', color: '#475569' };
  const text = STATUS_KEYS[status] ? t(STATUS_KEYS[status]) : status;
  return (
    <span style={{ padding: '3px 10px', borderRadius: '999px', fontSize: '11.5px', fontWeight: '700', background: colors.bg, color: colors.color, whiteSpace: 'nowrap' }}>
      {text}
    </span>
  );
}

// Постраничная навигация — при десятках тысяч записей (заявки, золотые
// записи) без неё видны только первые N по дате, а остальное как будто
// "пропадает" из списка.
function Pagination({ page, pageSize, total, onChange, t }) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1) return null;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '14px', fontSize: '12.5px', color: '#64748b' }}>
      <span>{format(t('paginationShowing'), { from, to, total })}</span>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          onClick={() => onChange(p => Math.max(1, p - 1))}
          disabled={page <= 1}
          style={{ ...btnGhost, padding: '6px 12px', fontSize: '12.5px', opacity: page <= 1 ? 0.5 : 1, cursor: page <= 1 ? 'default' : 'pointer' }}
        >
          {t('pagePrevBtn')}
        </button>
        <span style={{ padding: '6px 4px' }}>{page} / {pageCount}</span>
        <button
          onClick={() => onChange(p => Math.min(pageCount, p + 1))}
          disabled={page >= pageCount}
          style={{ ...btnGhost, padding: '6px 12px', fontSize: '12.5px', opacity: page >= pageCount ? 0.5 : 1, cursor: page >= pageCount ? 'default' : 'pointer' }}
        >
          {t('pageNextBtn')}
        </button>
      </div>
    </div>
  );
}

export default function MDMPage({ currentUser, lang, t, showNewRequest, onCloseNewRequest }) {
  const isSteward = currentUser?.role === 'steward' || currentUser?.role === 'admin';
  const ENTITY_TYPES = ENTITY_TYPE_KEYS.map(e => ({ value: e.value, label: t(e.key) }));
  const SOURCE_SYSTEMS = SOURCE_SYSTEM_KEYS.map(s => ({ value: s.value, label: t(s.key) }));

  const [tab, setTab] = useState('dashboard'); // dashboard | requests | golden
  const [dashboard, setDashboard] = useState(null);
  const [requests, setRequests] = useState([]);
  const [requestsTotal, setRequestsTotal] = useState(0);
  const [requestsPage, setRequestsPage] = useState(1);
  const REQUESTS_PAGE_SIZE = 50;
  const [statusFilter, setStatusFilter] = useState('');
  const [requestEntityFilter, setRequestEntityFilter] = useState('');
  const [periodPreset, setPeriodPreset] = useState('all'); // all | week | month | custom
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [goldenRecords, setGoldenRecords] = useState([]);
  const [goldenTotal, setGoldenTotal] = useState(0);
  const [goldenPage, setGoldenPage] = useState(1);
  const GOLDEN_PAGE_SIZE = 50;
  const [goldenEntityFilter, setGoldenEntityFilter] = useState('');
  const [goldenSearch, setGoldenSearch] = useState('');
  const debouncedGoldenSearch = useDebounced(goldenSearch, 300);
  const [loading, setLoading] = useState(false);
  const [openRequestId, setOpenRequestId] = useState(null);
  const [showMetricInfo, setShowMetricInfo] = useState(false);
  const [openGoldenId, setOpenGoldenId] = useState(null);
  const [showDirectCreate, setShowDirectCreate] = useState(false);

  const [newForm, setNewForm] = useState({ source_system: 'USP', entity_type: 'material', raw_name: '', unit: '', article: '' });
  const [submitting, setSubmitting] = useState(false);
  const [lastResult, setLastResult] = useState(null);

  const [liveMatches, setLiveMatches] = useState([]);
  const [liveMatchesLoading, setLiveMatchesLoading] = useState(false);
  const [showLiveMatches, setShowLiveMatches] = useState(false);
  const debouncedRawName = useDebounced(newForm.raw_name, 300);
  const searchBoxRef = useRef(null);

  useEffect(() => {
    if (!debouncedRawName.trim() || debouncedRawName.trim().length < 3) {
      setLiveMatches([]);
      return;
    }
    setLiveMatchesLoading(true);
    api.get('/search', { params: { entity_type: newForm.entity_type, q: debouncedRawName.trim() } })
      .then(res => setLiveMatches(res.data || []))
      .catch(() => setLiveMatches([]))
      .finally(() => setLiveMatchesLoading(false));
  }, [debouncedRawName, newForm.entity_type]);

  // Справочник единиц измерения (erp.dic_measures) — вместо свободного ввода
  const [measures, setMeasures] = useState([]);
  useEffect(() => {
    api.get('/erp/measures').then(res => setMeasures(res.data || [])).catch(() => {});
  }, []);

  // "Порог чистоты" — настраиваемый параметр (не хардкод в коде)
  const [settings, setSettings] = useState({ cleanliness_threshold: 0.55 });
  const loadSettings = useCallback(() => {
    api.get('/settings').then(res => setSettings(res.data)).catch(() => {});
  }, []);
  useEffect(() => { loadSettings(); }, [loadSettings]);
  const cleanlinessThreshold = settings.cleanliness_threshold ?? 0.55;
  const measureLabel = (m) => (m.translations && m.translations[lang]) || m.translations?.ru || m.code;

  useEffect(() => {
    const onClickOutside = (e) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target)) setShowLiveMatches(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const [dashPeriodPreset, setDashPeriodPreset] = useState('all');
  const [dashCustomFrom, setDashCustomFrom] = useState('');
  const [dashCustomTo, setDashCustomTo] = useState('');

  const loadDashboard = useCallback(() => {
    const params = periodToRange(dashPeriodPreset, dashCustomFrom, dashCustomTo);
    api.get('/dashboard', { params }).then(res => setDashboard(res.data)).catch(err => console.error(err));
  }, [dashPeriodPreset, dashCustomFrom, dashCustomTo]);

  // Период для "Заявок" — за неделю/месяц/весь период/свой диапазон. Границы
  // считаются на каждый вызов loadRequests (не на смену пресета), чтобы
  // "за неделю" всегда означала "последние 7 дней от сейчас", а не от момента
  // выбора пресета.
  const periodRange = useCallback(() => periodToRange(periodPreset, customFrom, customTo), [periodPreset, customFrom, customTo]);

  const loadRequests = useCallback(() => {
    setLoading(true);
    const params = { page: requestsPage, limit: REQUESTS_PAGE_SIZE, ...periodRange() };
    if (statusFilter) params.status = statusFilter;
    if (requestEntityFilter) params.entity_type = requestEntityFilter;
    api.get('/requests', { params })
      .then(res => { setRequests(res.data?.rows || []); setRequestsTotal(res.data?.total || 0); })
      .catch(err => console.error(err))
      .finally(() => setLoading(false));
  }, [statusFilter, requestEntityFilter, requestsPage, periodRange]);

  const loadGolden = useCallback(() => {
    const params = { page: goldenPage, limit: GOLDEN_PAGE_SIZE };
    if (goldenEntityFilter) params.entity_type = goldenEntityFilter;
    if (debouncedGoldenSearch.trim()) params.search = debouncedGoldenSearch.trim();
    api.get('/golden-records', { params })
      .then(res => { setGoldenRecords(res.data?.rows || []); setGoldenTotal(res.data?.total || 0); })
      .catch(err => console.error(err));
  }, [goldenEntityFilter, debouncedGoldenSearch, goldenPage]);

  // Смена фильтра — назад на первую страницу, иначе можно застрять на
  // несуществующей странице (например, была 10-я, а после фильтра результатов
  // всего 2 страницы).
  useEffect(() => { setRequestsPage(1); }, [statusFilter, requestEntityFilter, periodPreset, customFrom, customTo]);
  useEffect(() => { setGoldenPage(1); }, [goldenEntityFilter, debouncedGoldenSearch]);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);
  useEffect(() => { if (tab === 'requests') loadRequests(); }, [tab, loadRequests]);
  useEffect(() => { if (tab === 'golden') loadGolden(); }, [tab, loadGolden]);

  // ── Массовая синхронизация справочников ERP через Движок Дедупликации ──
  const [syncStatus, setSyncStatus] = useState(null);
  const syncPollRef = useRef(null);

  const pollSyncStatus = useCallback(() => {
    api.get('/erp/sync-status').then(res => {
      setSyncStatus(res.data);
      if (res.data.running) {
        syncPollRef.current = setTimeout(pollSyncStatus, 1200);
      } else {
        loadGolden();
        loadDashboard();
      }
    }).catch(() => {});
  }, [loadGolden, loadDashboard]);

  useEffect(() => {
    if (tab === 'golden') pollSyncStatus();
    return () => clearTimeout(syncPollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const startErpSync = async () => {
    try {
      const res = await api.post('/erp/sync-all');
      if (res.data.alreadyRunning) alert(t('syncAlreadyRunning'));
      pollSyncStatus();
    } catch (err) {
      alert(t('syncStartErrorPrefix') + (err.response?.data?.error || err.message));
    }
  };

  // Синхронизация "снизу вверх" — справочники Склада/Закупок/CostCAS. Общая
  // с ERP фоновая job-очередь (см. bulkSyncService.js) и тот же прогресс-бар —
  // CostCAS сама по себе не маленькая (16 тыс.+ работ), синхронно в рамках
  // одного HTTP-запроса это не уложить.
  const startExternalSync = async (connector) => {
    try {
      const res = await api.post(`/erp/sync-external/${connector}`);
      if (res.data.alreadyRunning) alert(t('syncAlreadyRunning'));
      pollSyncStatus();
    } catch (err) {
      alert(t('syncStartErrorPrefix') + (err.response?.data?.error || err.message));
    }
  };

  const submitNewRequest = async () => {
    if (!newForm.raw_name.trim()) return;
    setSubmitting(true);
    setLastResult(null);
    try {
      const rawAttributes = {};
      if (newForm.unit) rawAttributes.unit = newForm.unit;
      if (newForm.article.trim()) rawAttributes.article = newForm.article.trim();
      const res = await api.post('/requests', {
        source_system: newForm.source_system,
        entity_type: newForm.entity_type,
        raw_name: newForm.raw_name.trim(),
        local_id: 'draft_' + Date.now(),
        raw_attributes,
      });
      setLastResult(res.data);
      setNewForm(f => ({ ...f, raw_name: '', unit: '', article: '' }));
      loadDashboard();
      if (tab === 'requests') loadRequests();
    } catch (err) {
      alert(t('resolveErrorPrefix') + (err.response?.data?.error || err.message));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      {showNewRequest && (
        <div className="modal-overlay-center" onClick={onCloseNewRequest}>
          <div
            onClick={e => e.stopPropagation()}
            style={{
              ...card, width: '50vw', minWidth: '520px', maxWidth: '760px',
              maxHeight: '85vh', overflowY: 'auto', padding: '22px 24px', position: 'relative',
            }}
          >
            <button
              onClick={onCloseNewRequest}
              style={{ position: 'absolute', top: '16px', right: '16px', background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', padding: 0, display: 'flex' }}
            >
              <X size={18} />
            </button>
            <h3 style={{ margin: '0 0 4px', fontSize: '15px', fontWeight: '800' }}>{t('newRequestTitle')}</h3>
            <p style={{ margin: '0 0 16px', fontSize: '12.5px', color: '#94a3b8' }}>{t('newRequestHint')}</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', alignItems: 'end' }}>
              <div>
                <label style={label}>{t('fieldSource')}</label>
                <select style={input} value={newForm.source_system} onChange={e => setNewForm(f => ({ ...f, source_system: e.target.value }))}>
                  {SOURCE_SYSTEMS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <div>
                <label style={label}>{t('fieldEntityType')}</label>
                <select style={input} value={newForm.entity_type} onChange={e => setNewForm(f => ({ ...f, entity_type: e.target.value }))}>
                  {ENTITY_TYPES.map(e => <option key={e.value} value={e.value}>{e.label}</option>)}
                </select>
              </div>
              <div style={{ position: 'relative', gridColumn: 'span 2' }} ref={searchBoxRef}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <label style={{ ...label, marginBottom: 0 }}>{t('fieldName')}</label>
                  <button
                    type="button"
                    onClick={() => setShowMetricInfo(v => !v)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', display: 'flex', padding: 0, marginBottom: '5px' }}
                    title={t('metricInfoBtn')}
                  >
                    <Info size={12} />
                  </button>
                </div>
                {showMetricInfo && (
                  <div style={{ position: 'absolute', bottom: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 25, padding: '10px 12px', background: '#fef9c3', border: '1px solid #fde68a', borderRadius: '8px', fontSize: '11.5px', color: '#713f12', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div>{t('metricPgTrgm')}</div>
                    <div>{t('metricLevenshtein')}</div>
                    <div>{t('metricJaroWinkler')}</div>
                  </div>
                )}
                <div style={{ position: 'relative' }}>
                  <input
                    style={{ ...input, paddingRight: '30px' }}
                    value={newForm.raw_name}
                    placeholder={t('namePlaceholder')}
                    onChange={e => { setNewForm(f => ({ ...f, raw_name: e.target.value })); setShowLiveMatches(true); }}
                    onFocus={() => setShowLiveMatches(true)}
                  />
                  {liveMatchesLoading ? (
                    <RefreshCw size={13} className="spin" style={{ position: 'absolute', right: '9px', top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
                  ) : (
                    <Search size={13} style={{ position: 'absolute', right: '9px', top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
                  )}
                </div>

                {showLiveMatches && debouncedRawName.trim().length >= 3 && (
                  <div style={{
                    position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 20,
                    background: 'white', border: '1px solid #e2e8f0', borderRadius: '10px',
                    boxShadow: '0 8px 24px rgba(15,23,42,0.12)', maxHeight: '220px', overflowY: 'auto',
                  }}>
                    {liveMatches.length === 0 && !liveMatchesLoading && (
                      <div style={{ padding: '12px 14px', fontSize: '12.5px', color: '#15803d', fontWeight: '600' }}>
                        {t('noSimilarFound')}
                      </div>
                    )}
                    {liveMatches.map(m => (
                      <div
                        key={m.id}
                        onClick={() => { setNewForm(f => ({ ...f, raw_name: goldenName(m, lang) })); setShowLiveMatches(false); }}
                        style={{ padding: '10px 14px', borderBottom: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
                      >
                        <span style={{ fontSize: '13px', fontWeight: '600', color: '#0f172a' }}>{goldenName(m, lang)}</span>
                        <span style={{ display: 'flex', gap: '5px' }}>
                          <span title="pg_trgm" style={{
                            fontSize: '11px', fontWeight: '700', padding: '2px 8px', borderRadius: '999px',
                            background: m.score >= cleanlinessThreshold ? '#dcfce7' : '#fef3c7',
                            color: m.score >= cleanlinessThreshold ? '#15803d' : '#92400e',
                          }}>
                            {(m.score * 100).toFixed(0)}%
                          </span>
                          <span title="Levenshtein" style={{
                            fontSize: '11px', fontWeight: '700', padding: '2px 8px', borderRadius: '999px',
                            background: '#ede9fe', color: '#6d28d9',
                          }}>
                            LEV {(m.levenshtein_score * 100).toFixed(0)}%
                          </span>
                          <span title="Jaro-Winkler" style={{
                            fontSize: '11px', fontWeight: '700', padding: '2px 8px', borderRadius: '999px',
                            background: '#fce7f3', color: '#be185d',
                          }}>
                            JW {(m.jaro_winkler_score * 100).toFixed(0)}%
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <label style={label}>{t('fieldArticle')}</label>
                <input style={input} value={newForm.article} onChange={e => setNewForm(f => ({ ...f, article: e.target.value }))} />
              </div>
              <div>
                <label style={label}>{t('fieldUnit')}</label>
                <select style={input} value={newForm.unit} onChange={e => setNewForm(f => ({ ...f, unit: e.target.value }))}>
                  <option value="">—</option>
                  {measures.map(m => <option key={m.code} value={m.code}>{measureLabel(m)}</option>)}
                </select>
              </div>
              <button style={{ ...btnPrimary, gridColumn: '1 / -1', justifyContent: 'center' }} disabled={submitting} onClick={submitNewRequest}>
                {submitting ? <RefreshCw size={14} className="spin" /> : <PlusCircle size={14} />} {t('submitBtn')}
              </button>
            </div>

            {lastResult && (
              <div style={{ marginTop: '18px', padding: '14px 16px', borderRadius: '10px', background: (STATUS_COLORS[lastResult.status] || {}).bg || '#f1f5f9', border: '1px solid ' + ((STATUS_COLORS[lastResult.status] || {}).color || '#cbd5e1') }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
                  <StatusBadge status={lastResult.status} t={t} />
                  <strong style={{ fontSize: '13.5px', color: '#0f172a' }}>«{lastResult.raw_name}»</strong>
                </div>
                <div style={{ fontSize: '12.5px', color: '#475569' }}>
                  {lastResult.status === 'merged' && format(t('matchCleanResult'), { score: (lastResult.match_score * 100).toFixed(0), threshold: (cleanlinessThreshold * 100).toFixed(0) })}
                  {lastResult.status === 'conflict' && format(t('matchDirtyResult'), { score: (lastResult.match_score * 100).toFixed(0), threshold: (cleanlinessThreshold * 100).toFixed(0), tab: t('tabRequests') })}
                </div>
              </div>
            )}

            {isSteward && (
              <div style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid #e2e8f0' }}>
                <CleanlinessThresholdSetting
                  value={cleanlinessThreshold}
                  onSaved={(v) => setSettings(s => ({ ...s, cleanliness_threshold: v }))}
                  t={t}
                />
              </div>
            )}

            {isSteward && (
              <div style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid #e2e8f0' }}>
                <UnificationFieldsSetting entityTypes={ENTITY_TYPES} t={t} />
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '4px', borderBottom: '1px solid #e2e8f0', marginBottom: '22px' }}>
        {[
          { id: 'dashboard', label: t('tabDashboard'), icon: LayoutDashboard },
          { id: 'requests', label: t('tabRequests'), icon: Inbox },
          { id: 'golden', label: t('tabGolden'), icon: Database },
        ].map(tabDef => (
          <button
            key={tabDef.id}
            onClick={() => setTab(tabDef.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              padding: '10px 18px', fontSize: '14px', fontWeight: '700',
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: tab === tabDef.id ? '#3b82f6' : '#64748b',
              borderBottom: tab === tabDef.id ? '2px solid #3b82f6' : '2px solid transparent',
              marginBottom: '-1px',
            }}
          >
            <tabDef.icon size={16} /> {tabDef.label}
          </button>
        ))}
      </div>

      {tab === 'dashboard' && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '28px' }}>
            <div style={{ ...card, padding: '18px 20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '6px', marginBottom: '8px' }}>
                <div style={{ fontSize: '12px', fontWeight: '700', color: '#64748b', textTransform: 'uppercase' }}>{t('statQueueNew')}</div>
                <select
                  style={{ fontSize: '11px', padding: '2px 4px', borderRadius: '6px', border: '1px solid #e2e8f0', color: '#64748b', background: 'white' }}
                  value={dashPeriodPreset}
                  onChange={e => setDashPeriodPreset(e.target.value)}
                >
                  <option value="all">{t('periodAll')}</option>
                  <option value="week">{t('periodWeek')}</option>
                  <option value="month">{t('periodMonth')}</option>
                  <option value="custom">{t('periodCustom')}</option>
                </select>
              </div>
              {dashPeriodPreset === 'custom' && (
                <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
                  <input type="date" style={{ fontSize: '11px', padding: '3px 4px', borderRadius: '6px', border: '1px solid #e2e8f0', width: '50%' }} value={dashCustomFrom} onChange={e => setDashCustomFrom(e.target.value)} />
                  <input type="date" style={{ fontSize: '11px', padding: '3px 4px', borderRadius: '6px', border: '1px solid #e2e8f0', width: '50%' }} value={dashCustomTo} onChange={e => setDashCustomTo(e.target.value)} />
                </div>
              )}
              <div style={{ fontSize: '30px', fontWeight: '800', color: '#0f172a' }}>{dashboard?.queueNew ?? '—'}</div>
            </div>
            <div style={{ ...card, padding: '18px 20px' }}>
              <div style={{ fontSize: '12px', fontWeight: '700', color: '#92400e', textTransform: 'uppercase', marginBottom: '8px' }}>{t('statQueueConflict')}</div>
              <div style={{ fontSize: '30px', fontWeight: '800', color: '#92400e' }}>{dashboard?.queueConflict ?? '—'}</div>
            </div>
            <div style={{ ...card, padding: '18px 20px' }}>
              <div style={{ fontSize: '12px', fontWeight: '700', color: '#15803d', textTransform: 'uppercase', marginBottom: '8px' }}>{t('statAutoRate')}</div>
              <div style={{ fontSize: '30px', fontWeight: '800', color: '#15803d' }}>{dashboard?.autoMergeRatePct ?? '—'}%</div>
            </div>
            <div style={{ ...card, padding: '18px 20px' }}>
              <div style={{ fontSize: '12px', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', marginBottom: '8px' }}>{t('statTotalGolden')}</div>
              <div style={{ fontSize: '30px', fontWeight: '800', color: '#0f172a' }}>{dashboard?.totalGoldenRecords ?? '—'}</div>
            </div>
          </div>

          <div style={{ ...card, padding: '18px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: '10px' }}>
              <Radio size={13} /> {t('busMonitor')}
            </div>
            {(dashboard?.busEvents || []).length === 0 && <span style={{ color: '#94a3b8', fontSize: '13px' }}>{t('busEmpty')}</span>}
            {(dashboard?.busEvents || []).map(ev => (
              <div key={ev.id} style={{ display: 'grid', gridTemplateColumns: '1fr 100px 90px', gap: '10px', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f1f5f9', fontSize: '12.5px' }}>
                <span style={{ fontFamily: 'monospace', color: '#1d4ed8' }}>{ev.topic}</span>
                <span style={{ color: '#15803d', fontWeight: 700 }}>{ev.status}</span>
                <span style={{ color: '#94a3b8', textAlign: 'right' }}>{new Date(ev.created_at).toLocaleTimeString(localeFor(lang))}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'requests' && (
        <div style={{ ...card, padding: '20px 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: '800' }}>{t('requestsQueueTitle')}</h3>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
              <select style={{ ...input, width: 'auto' }} value={requestEntityFilter} onChange={e => setRequestEntityFilter(e.target.value)}>
                <option value="">{t('allTypes')}</option>
                {ENTITY_TYPES.map(e => <option key={e.value} value={e.value}>{e.label}</option>)}
              </select>
              <select style={{ ...input, width: 'auto' }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                <option value="">{t('allStatuses')}</option>
                {Object.entries(STATUS_KEYS).map(([k, key]) => <option key={k} value={k}>{t(key)}</option>)}
              </select>
              <select style={{ ...input, width: 'auto' }} value={periodPreset} onChange={e => setPeriodPreset(e.target.value)}>
                <option value="all">{t('periodAll')}</option>
                <option value="week">{t('periodWeek')}</option>
                <option value="month">{t('periodMonth')}</option>
                <option value="custom">{t('periodCustom')}</option>
              </select>
              {periodPreset === 'custom' && (
                <>
                  <input type="date" style={{ ...input, width: 'auto' }} value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
                  <span style={{ color: '#94a3b8' }}>—</span>
                  <input type="date" style={{ ...input, width: 'auto' }} value={customTo} onChange={e => setCustomTo(e.target.value)} />
                </>
              )}
            </div>
          </div>
          {loading ? <p style={{ color: '#94a3b8' }}>{t('loading')}</p> : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  <th style={{ textAlign: 'left', padding: '8px 10px', color: '#64748b', fontSize: '11px', textTransform: 'uppercase' }}>{t('colSource')}</th>
                  <th style={{ textAlign: 'left', padding: '8px 10px', color: '#64748b', fontSize: '11px', textTransform: 'uppercase' }}>{t('colName')}</th>
                  <th style={{ textAlign: 'left', padding: '8px 10px', color: '#64748b', fontSize: '11px', textTransform: 'uppercase' }}>{t('colType')}</th>
                  <th style={{ textAlign: 'left', padding: '8px 10px', color: '#64748b', fontSize: '11px', textTransform: 'uppercase' }}>{t('colMatch')}</th>
                  <th style={{ textAlign: 'left', padding: '8px 10px', color: '#64748b', fontSize: '11px', textTransform: 'uppercase' }}>{t('colStatus')}</th>
                  <th style={{ textAlign: 'right', padding: '8px 10px' }}></th>
                </tr>
              </thead>
              <tbody>
                {requests.map(r => (
                  <tr key={r.id} style={{ borderBottom: '1px solid #f1f5f9', cursor: 'pointer' }} onClick={() => setOpenRequestId(r.id)}>
                    <td style={{ padding: '9px 10px', color: '#64748b' }}>{r.source_system}</td>
                    <td style={{ padding: '9px 10px', fontWeight: '600', color: '#1d4ed8' }}>{requestName(r, lang)}</td>
                    <td style={{ padding: '9px 10px', color: '#64748b' }}>{ENTITY_TYPES.find(e => e.value === r.entity_type)?.label || r.entity_type}</td>
                    <td style={{ padding: '9px 10px', color: '#64748b', fontSize: '12px' }}>
                      {r.match_score != null ? (r.match_score * 100).toFixed(0) + '%' : '—'}
                      {r.candidates?.[0]?.levenshtein_score != null && (
                        <span style={{ color: '#94a3b8' }}> · LEV {(r.candidates[0].levenshtein_score * 100).toFixed(0)}%</span>
                      )}
                      {r.candidates?.[0]?.jaro_winkler_score != null && (
                        <span style={{ color: '#94a3b8' }}> · JW {(r.candidates[0].jaro_winkler_score * 100).toFixed(0)}%</span>
                      )}
                    </td>
                    <td style={{ padding: '9px 10px' }}><StatusBadge status={r.status} t={t} /></td>
                    <td style={{ padding: '9px 10px', textAlign: 'right' }}>
                      {r.status === 'conflict' && !isSteward && (
                        <span style={{ fontSize: '11.5px', color: '#94a3b8' }}>{t('waitingSteward')}</span>
                      )}
                    </td>
                  </tr>
                ))}
                {requests.length === 0 && (
                  <tr><td colSpan="6" style={{ padding: '30px', textAlign: 'center', color: '#94a3b8' }}>{t('requestsEmpty')}</td></tr>
                )}
              </tbody>
            </table>
          )}
          <Pagination page={requestsPage} pageSize={REQUESTS_PAGE_SIZE} total={requestsTotal} onChange={setRequestsPage} t={t} />
        </div>
      )}

      {tab === 'golden' && (
        <div style={{ ...card, padding: '20px 24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h3 style={{ margin: 0, fontSize: '15px', fontWeight: '800' }}>{t('goldenTitle')}</h3>
            <div style={{ display: 'flex', gap: '10px' }}>
              {isSteward && (
                <button style={btnGhost} disabled={syncStatus?.running} onClick={startErpSync}>
                  {syncStatus?.running ? <RefreshCw size={14} className="spin" /> : <UploadCloud size={14} />}
                  {syncStatus?.running ? t('syncRunning') : t('syncBtn')}
                </button>
              )}
              {isSteward && (
                <button style={btnGhost} disabled={syncStatus?.running} onClick={() => startExternalSync('warehouse')}>
                  <UploadCloud size={14} /> {t('syncWarehouseBtn')}
                </button>
              )}
              {isSteward && (
                <button style={btnGhost} disabled={syncStatus?.running} onClick={() => startExternalSync('procurement')}>
                  <UploadCloud size={14} /> {t('syncProcurementBtn')}
                </button>
              )}
              {isSteward && (
                <button style={btnGhost} disabled={syncStatus?.running} onClick={() => startExternalSync('costcas')}>
                  <UploadCloud size={14} /> {t('syncCostcasBtn')}
                </button>
              )}
              {isSteward && (
                <button style={btnPrimary} onClick={() => setShowDirectCreate(true)}>
                  <PlusCircle size={14} /> {t('directCreateBtn')}
                </button>
              )}
            </div>
          </div>

          {syncStatus && (syncStatus.running || syncStatus.finishedAt) && (
            <div style={{ marginBottom: '18px', padding: '14px 16px', borderRadius: '10px', background: '#f8fafc', border: '1px solid #e2e8f0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <strong style={{ fontSize: '13px' }}>{syncStatus.running ? t('syncRunning') : t('syncDone')}</strong>
                <span style={{ fontSize: '12.5px', color: '#64748b' }}>{syncStatus.totalProcessed} / {syncStatus.totalCount}</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', fontSize: '12px', color: '#64748b' }}>
                {Object.entries(syncStatus.perType || {}).map(([type, s]) => (
                  <span key={type}>
                    {ENTITY_TYPES.find(e => e.value === type)?.label || type}: {s.processed}/{s.total}
                    {' '}(<span style={{ color: '#15803d' }}>{s.created || 0} {t('syncNew')}</span>,{' '}
                    <span style={{ color: '#1d4ed8' }}>{s.merged || 0} {t('syncMerged')}</span>,{' '}
                    <span style={{ color: '#92400e' }}>{s.conflict || 0} {t('syncConflict')}</span>)
                  </span>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: '12px', marginBottom: '14px' }}>
            <select style={input} value={goldenEntityFilter} onChange={e => setGoldenEntityFilter(e.target.value)}>
              <option value="">{t('allTypes')}</option>
              {ENTITY_TYPES.map(e => <option key={e.value} value={e.value}>{e.label}</option>)}
            </select>
            <div style={{ position: 'relative' }}>
              <input
                style={{ ...input, paddingRight: '30px' }}
                value={goldenSearch}
                placeholder={t('searchByName')}
                onChange={e => setGoldenSearch(e.target.value)}
              />
              <Search size={13} style={{ position: 'absolute', right: '9px', top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
            </div>
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <th style={{ textAlign: 'left', padding: '8px 10px', color: '#64748b', fontSize: '11px', textTransform: 'uppercase' }}>{t('colName')}</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', color: '#64748b', fontSize: '11px', textTransform: 'uppercase' }}>{t('colArticle')}</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', color: '#64748b', fontSize: '11px', textTransform: 'uppercase' }}>{t('colType')}</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', color: '#64748b', fontSize: '11px', textTransform: 'uppercase' }}>{t('colUnit')}</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', color: '#64748b', fontSize: '11px', textTransform: 'uppercase' }}>{t('colCreated')}</th>
              </tr>
            </thead>
            <tbody>
              {goldenRecords.map(g => (
                <tr key={g.id} style={{ borderBottom: '1px solid #f1f5f9', cursor: 'pointer' }} onClick={() => setOpenGoldenId(g.id)}>
                  <td style={{ padding: '9px 10px', fontWeight: '600', color: '#1d4ed8' }}>{goldenName(g, lang)}</td>
                  <td style={{ padding: '9px 10px', color: '#64748b', fontFamily: 'monospace', fontSize: '12px' }}>{g.article || '—'}</td>
                  <td style={{ padding: '9px 10px', color: '#64748b' }}>{ENTITY_TYPES.find(e => e.value === g.entity_type)?.label || g.entity_type}</td>
                  <td style={{ padding: '9px 10px', color: '#64748b' }}>{goldenUnit(g, lang)}</td>
                  <td style={{ padding: '9px 10px', color: '#64748b' }}>{new Date(g.created_at).toLocaleString(localeFor(lang))}</td>
                </tr>
              ))}
              {goldenRecords.length === 0 && (
                <tr><td colSpan="5" style={{ padding: '30px', textAlign: 'center', color: '#94a3b8' }}>{t('goldenEmpty')}</td></tr>
              )}
            </tbody>
          </table>
          <Pagination page={goldenPage} pageSize={GOLDEN_PAGE_SIZE} total={goldenTotal} onChange={setGoldenPage} t={t} />
        </div>
      )}

      {openRequestId && (
        <RequestDetail
          id={openRequestId}
          lang={lang}
          t={t}
          isSteward={isSteward}
          entityTypes={ENTITY_TYPES}
          onClose={() => setOpenRequestId(null)}
          onResolved={() => { loadDashboard(); loadRequests(); }}
        />
      )}

      {openGoldenId && (
        <GoldenRecordDetail
          id={openGoldenId}
          lang={lang}
          t={t}
          isSteward={isSteward}
          onClose={() => setOpenGoldenId(null)}
          onDeleted={() => { loadGolden(); loadDashboard(); }}
        />
      )}

      {showDirectCreate && (
        <DirectCreateModal
          t={t}
          entityTypes={ENTITY_TYPES}
          measures={measures}
          measureLabel={measureLabel}
          onClose={() => setShowDirectCreate(false)}
          onCreated={() => { setShowDirectCreate(false); loadGolden(); loadDashboard(); }}
        />
      )}

    </div>
  );
}

function CleanlinessThresholdSetting({ value, onSaved, t }) {
  const [percent, setPercent] = useState(Math.round(value * 100));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setPercent(Math.round(value * 100)); }, [value]);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const v = Math.min(100, Math.max(0, Number(percent))) / 100;
      await api.patch('/settings', { cleanliness_threshold: v });
      onSaved(v);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      alert(t('resolveErrorPrefix') + (err.response?.data?.error || err.message));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: '8px' }}>
        {t('cleanlinessThresholdTitle')}
      </div>
      <p style={{ margin: '0 0 12px', fontSize: '12.5px', color: '#94a3b8' }}>
        {t('cleanlinessThresholdHint')}
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <input
          type="number" min="0" max="100" value={percent}
          onChange={e => setPercent(e.target.value)}
          style={{ width: '90px', padding: '9px 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '13px' }}
        />
        <span style={{ fontSize: '13px', color: '#64748b' }}>%</span>
        <button
          onClick={save}
          disabled={saving}
          style={{ padding: '9px 16px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '8px', fontWeight: '700', fontSize: '13px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          {saving ? <RefreshCw size={14} className="spin" /> : <Check size={14} />} {t('saveBtn')}
        </button>
        {saved && <span style={{ color: '#15803d', fontSize: '12.5px', fontWeight: 700 }}>{t('savedLabel')}</span>}
      </div>
    </div>
  );
}

// П.5: настраиваемые "поля унификации" — по каким полям сущность считается
// точно той же самой (независимо от нечёткого сходства названия).
function UnificationFieldsSetting({ entityTypes, t }) {
  const [byType, setByType] = useState({});
  const [savingKey, setSavingKey] = useState(null);

  useEffect(() => {
    api.get('/unification-fields').then(res => setByType(res.data?.byEntityType || {})).catch(() => {});
  }, []);

  const toggle = async (entityType, field) => {
    const current = byType[entityType] || [];
    const next = current.includes(field) ? current.filter(f => f !== field) : [...current, field];
    setByType(b => ({ ...b, [entityType]: next }));
    setSavingKey(entityType + field);
    try {
      await api.put(`/unification-fields/${entityType}`, { fields: next });
    } catch (err) {
      setByType(b => ({ ...b, [entityType]: current }));
      alert(t('resolveErrorPrefix') + (err.response?.data?.error || err.message));
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: '8px' }}>
        {t('unificationFieldsTitle')}
      </div>
      <p style={{ margin: '0 0 12px', fontSize: '12.5px', color: '#94a3b8' }}>
        {t('unificationFieldsHint')}
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
        <thead>
          <tr style={{ background: '#f8fafc' }}>
            <th style={{ textAlign: 'left', padding: '8px 10px', color: '#64748b', fontSize: '11px', textTransform: 'uppercase' }}>{t('fieldEntityType')}</th>
            <th style={{ textAlign: 'center', padding: '8px 10px', color: '#64748b', fontSize: '11px', textTransform: 'uppercase' }}>{t('ufFieldArticle')}</th>
            <th style={{ textAlign: 'center', padding: '8px 10px', color: '#64748b', fontSize: '11px', textTransform: 'uppercase' }}>{t('ufFieldName')}</th>
          </tr>
        </thead>
        <tbody>
          {entityTypes.map(e => (
            <tr key={e.value} style={{ borderBottom: '1px solid #f1f5f9' }}>
              <td style={{ padding: '8px 10px' }}>{e.label}</td>
              <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                <input
                  type="checkbox"
                  checked={(byType[e.value] || []).includes('article')}
                  disabled={savingKey === e.value + 'article'}
                  onChange={() => toggle(e.value, 'article')}
                />
              </td>
              <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                <input
                  type="checkbox"
                  checked={(byType[e.value] || []).includes('normalized_name')}
                  disabled={savingKey === e.value + 'normalized_name'}
                  onChange={() => toggle(e.value, 'normalized_name')}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DirectCreateModal({ onClose, onCreated, t, entityTypes, measures, measureLabel }) {
  const [form, setForm] = useState({ entity_type: 'material', normalized_name: '', article: '', material_group: '', base_unit: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    if (!form.normalized_name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.post('/golden-records', form);
      onCreated();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: 'white', borderRadius: '14px', padding: '26px 28px', width: '520px', maxWidth: '92vw', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
          <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '800' }}>{t('directCreateTitle')}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8' }}><X size={18} /></button>
        </div>
        <p style={{ margin: '0 0 18px', fontSize: '12.5px', color: '#94a3b8' }}>{t('directCreateHint')}</p>

        <label style={label}>{t('fieldEntityType')}</label>
        <select style={{ ...input, marginBottom: '12px' }} value={form.entity_type} onChange={e => setForm(f => ({ ...f, entity_type: e.target.value }))}>
          {entityTypes.map(e => <option key={e.value} value={e.value}>{e.label}</option>)}
        </select>

        <label style={label}>{t('fieldName')}</label>
        <input style={{ ...input, marginBottom: '12px' }} value={form.normalized_name} onChange={e => setForm(f => ({ ...f, normalized_name: e.target.value }))} placeholder={t('namePlaceholder')} />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
          <div>
            <label style={label}>{t('fieldArticle')}</label>
            <input style={input} value={form.article} onChange={e => setForm(f => ({ ...f, article: e.target.value }))} />
          </div>
          <div>
            <label style={label}>{t('fieldMaterialGroup')}</label>
            <input style={input} value={form.material_group} onChange={e => setForm(f => ({ ...f, material_group: e.target.value }))} />
          </div>
        </div>

        <label style={label}>{t('fieldBaseUnit')}</label>
        <select style={{ ...input, marginBottom: '18px' }} value={form.base_unit} onChange={e => setForm(f => ({ ...f, base_unit: e.target.value }))}>
          <option value="">—</option>
          {measures.map(m => <option key={m.code} value={m.code}>{measureLabel(m)}</option>)}
        </select>

        {error && <p style={{ color: 'var(--danger)', fontSize: '12.5px', marginBottom: '12px' }}>{error}</p>}

        <button style={{ ...btnPrimary, width: '100%', justifyContent: 'center' }} disabled={saving} onClick={save}>
          {saving ? <RefreshCw size={14} className="spin" /> : <Check size={14} />} {t('createGoldenBtn')}
        </button>
      </div>
    </div>
  );
}
