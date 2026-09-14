// Ловим SSO-токен ERP из URL (?token=...), как описано в MODULE_DEVELOPER_GUIDE.md:
// ERP открывает модуль по адресу вида GET https://.../?token=eyJhbGci... — задача
// фронтенда поймать его один раз и дальше слать на backend в Authorization: Bearer.
const STORAGE_KEY = 'mdm_sso_token';

export function captureTokenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  if (token) {
    sessionStorage.setItem(STORAGE_KEY, token);
    params.delete('token');
    const rest = params.toString();
    const cleanUrl = window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash;
    window.history.replaceState({}, '', cleanUrl);
  }
}

export function getToken() {
  return sessionStorage.getItem(STORAGE_KEY);
}

export function setToken(token) {
  sessionStorage.setItem(STORAGE_KEY, token);
}

export function clearToken() {
  sessionStorage.removeItem(STORAGE_KEY);
}

// Только для отображения в шапке (email/роль) — НЕ используется для проверки
// подлинности, реальная верификация подписи всегда происходит на backend.
export function decodeTokenPayload(token) {
  try {
    const payload = token.split('.')[1];
    const json = decodeURIComponent(
      atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
        .split('')
        .map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('')
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}
