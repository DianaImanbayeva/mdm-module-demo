import React, { useEffect, useState, useCallback, useRef } from 'react';
import { GitMerge, LogOut, ShieldCheck, User, Search, Bell, ChevronDown, Plus } from 'lucide-react';
import axios from 'axios';
import { captureTokenFromUrl, getToken, setToken, clearToken, decodeTokenPayload } from './auth';
import { LOCALES, translate } from './i18n';
import MDMPage from './pages/MDMPage';

const DEV_MODE = String(import.meta.env.VITE_DEV_MODE || 'false').toLowerCase() === 'true';
const LANG_STORAGE_KEY = 'mdm_lang';

// Ловим ?token=... из URL один раз при самом первом рендере модуля (см. auth.js
// и MODULE_DEVELOPER_GUIDE.md — так ERP Core передаёт SSO-пропуск пользователя).
captureTokenFromUrl();

function DevLoginScreen({ onLoggedIn, t }) {
  const [role, setRole] = useState('steward');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const login = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await axios.post('/dev/login', { role });
      setToken(res.data.token);
      onLoggedIn();
    } catch (err) {
      setError(t('devLoginErrorPrefix') + (err.response?.data?.error || err.message));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-main)' }}>
      <div style={{ background: 'white', borderRadius: '20px', padding: '36px 40px', boxShadow: '0 20px 60px rgba(15,23,42,0.12)', width: '380px', maxWidth: '92vw' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
          <GitMerge size={22} color="var(--primary)" />
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800 }}>{t('devLoginTitle')}</h2>
        </div>
        <p style={{ margin: '0 0 22px', fontSize: '13px', color: 'var(--text-muted)' }}>{t('devLoginHint')}</p>

        <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '6px', display: 'block' }}>
          {t('devLoginRole')}
        </label>
        <select
          value={role}
          onChange={e => setRole(e.target.value)}
          style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '13px', marginBottom: '18px' }}
        >
          <option value="steward">{t('roleSteward')}</option>
          <option value="user">{t('roleUser')}</option>
        </select>

        <button
          onClick={login}
          disabled={loading}
          style={{ width: '100%', padding: '11px', background: 'var(--primary)', color: 'white', border: 'none', borderRadius: '10px', fontWeight: 700, cursor: 'pointer' }}
        >
          {loading ? t('devLoginLoading') : t('devLoginBtn')}
        </button>
        {error && <p style={{ color: 'var(--danger)', fontSize: '12.5px', marginTop: '12px' }}>{error}</p>}
      </div>
    </div>
  );
}

function WaitingForSsoScreen({ t }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-main)' }}>
      <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
        <ShieldCheck size={32} style={{ marginBottom: '10px' }} />
        <p>{t('waitingSso')}</p>
      </div>
    </div>
  );
}

function LangSwitcher({ lang, setLang }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const onClick = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);
  const current = LOCALES.find(l => l.value === lang) || LOCALES[0];
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: '13px', color: '#334155', padding: '6px 8px' }}
      >
        {current.label} <ChevronDown size={12} />
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, background: 'white', border: '1px solid #e2e8f0', borderRadius: '10px', boxShadow: '0 8px 24px rgba(15,23,42,0.12)', minWidth: '160px', zIndex: 50, overflow: 'hidden' }}>
          {LOCALES.map(l => (
            <div
              key={l.value}
              onClick={() => { setLang(l.value); setOpen(false); }}
              style={{
                padding: '10px 14px', fontSize: '13px', cursor: 'pointer',
                background: l.value === lang ? '#eff6ff' : 'white',
                color: l.value === lang ? '#1d4ed8' : '#334155',
                fontWeight: l.value === lang ? 700 : 500,
              }}
            >
              {l.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function UserMenu({ payload, t, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const onClick = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);
  const initials = (payload?.email || '??').slice(0, 2).toUpperCase();
  const roleLabel = payload?.role === 'steward' || payload?.role === 'admin' ? t('roleSteward') : t('roleUser');

  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px' }}
      >
        <div style={{ width: '26px', height: '26px', borderRadius: '50%', background: 'var(--primary)', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 700 }}>
          {initials}
        </div>
        <span style={{ fontSize: '13px', fontWeight: 700, color: '#0f172a', maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {payload?.email || '—'}
        </span>
        <ChevronDown size={13} color="#94a3b8" />
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, background: 'white', border: '1px solid #e2e8f0', borderRadius: '10px', boxShadow: '0 8px 24px rgba(15,23,42,0.12)', minWidth: '200px', zIndex: 50, overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid #f1f5f9' }}>
            <div style={{ fontSize: '13px', fontWeight: 700, color: '#0f172a' }}>{payload?.email}</div>
            <div style={{ fontSize: '12px', color: '#94a3b8' }}>{roleLabel}</div>
          </div>
          <button
            onClick={onLogout}
            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', fontSize: '13px', color: '#ef4444', textAlign: 'left' }}
          >
            <LogOut size={14} /> {t('logout')}
          </button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [token, setTokenState] = useState(() => getToken());
  const [lang, setLangState] = useState(() => sessionStorage.getItem(LANG_STORAGE_KEY) || 'ru');
  const [showNewRequest, setShowNewRequest] = useState(false);

  const setLang = useCallback((l) => {
    sessionStorage.setItem(LANG_STORAGE_KEY, l);
    setLangState(l);
  }, []);
  const t = useCallback((key) => translate(lang, key), [lang]);

  const refresh = useCallback(() => setTokenState(getToken()), []);

  useEffect(() => {
    const onUnauthorized = () => refresh();
    window.addEventListener('mdm:unauthorized', onUnauthorized);
    return () => window.removeEventListener('mdm:unauthorized', onUnauthorized);
  }, [refresh]);

  if (!token) {
    return DEV_MODE ? <DevLoginScreen onLoggedIn={refresh} t={t} /> : <WaitingForSsoScreen t={t} />;
  }

  const payload = decodeTokenPayload(token);
  // Реальный бизнес-role лежит в app_metadata.role — верхнеуровневый "role" у
  // токенов Supabase Auth почти всегда "authenticated"/"anon" (служебная роль
  // для RLS, не имеет отношения к правам в модуле). Та же логика уже
  // применяется на backend (middleware/auth.js) — здесь синхронизирована,
  // чтобы шапка и кнопки Стюарда не расходились с тем, что реально разрешает API.
  if (payload) payload.role = payload.app_metadata?.role || payload.role;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '18px', padding: '10px 24px', background: 'white', borderBottom: '1px solid #e2e8f0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 800, fontSize: '14px', color: '#0f172a', flexShrink: 0 }}>
          <GitMerge size={18} color="var(--primary)" /> MDM
        </div>

        <div style={{ flex: 1, position: 'relative', maxWidth: '480px' }}>
          <Search size={14} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
          <input
            disabled
            placeholder={t('searchPlaceholder')}
            style={{ width: '100%', padding: '9px 12px 9px 34px', borderRadius: '10px', border: '1px solid #e2e8f0', fontSize: '13px', background: '#f8fafc', color: '#94a3b8' }}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginLeft: 'auto' }}>
          <LangSwitcher lang={lang} setLang={setLang} />
          <button style={{ position: 'relative', background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' }}>
            <Bell size={18} />
          </button>
          <UserMenu payload={payload} t={t} onLogout={() => { clearToken(); refresh(); }} />
          <button
            onClick={() => setShowNewRequest(true)}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'var(--primary)', color: 'white', border: 'none', borderRadius: '8px', padding: '9px 16px', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}
          >
            <Plus size={14} /> {t('createBtn')}
          </button>
        </div>
      </div>

      <div style={{ padding: '28px 40px', maxWidth: '1400px', margin: '0 auto' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 800, color: '#0f172a', margin: '0 0 4px' }}>{t('appTitle')}</h1>
        <p style={{ fontSize: '13px', color: '#64748b', margin: '0 0 24px' }}>{t('appSubtitle')}</p>
        <MDMPage
          currentUser={payload}
          lang={lang}
          t={t}
          showNewRequest={showNewRequest}
          onCloseNewRequest={() => setShowNewRequest(false)}
        />
      </div>
    </div>
  );
}
