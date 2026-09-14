import axios from 'axios';
import { getToken, clearToken } from './auth';

// Относительный путь: в проде фронтенд и backend отдаются с одного порта
// (см. server.js), в деве vite proxy (vite.config.js) пробрасывает /api на backend.
const baseURL = '/api/v1';

const api = axios.create({ baseURL });

api.interceptors.request.use(config => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      // Токен протух/недействителен — сбрасываем, чтобы показать экран входа заново.
      clearToken();
      window.dispatchEvent(new Event('mdm:unauthorized'));
    }
    return Promise.reject(err);
  }
);

export default api;
