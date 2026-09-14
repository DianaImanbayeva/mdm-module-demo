// Настраиваемые параметры движка (по просьбе: "процент чистоты в параметры,
// не в код"). Храним в собственной таблице mdm_settings (key/value), с простым
// in-memory кешем — читаем на каждый processRequest (десятки тысяч раз при
// массовой синхронизации), поэтому не ходим в БД каждый раз, а обновляем кеш
// сразу же при сохранении настройки через API.
const pg = require('../lib/pgrest');
const { mdmSchema } = require('../config/env');

const DEFAULTS = {
    cleanliness_threshold: 0.55,
};

let cache = null;

async function loadAll() {
    if (cache) return cache;
    const rows = await pg.get(mdmSchema, 'mdm_settings', { select: 'key,value' });
    cache = { ...DEFAULTS };
    for (const r of rows || []) cache[r.key] = r.value;
    return cache;
}

async function getSetting(key) {
    const all = await loadAll();
    return all[key] !== undefined ? all[key] : DEFAULTS[key];
}

async function setSetting(key, value, updatedBy) {
    await pg.post(mdmSchema, 'mdm_settings',
        { key, value, updated_by: updatedBy || null },
        'resolution=merge-duplicates,return=minimal');
    if (!cache) await loadAll();
    cache[key] = value;
    return value;
}

async function getAllSettings() {
    return loadAll();
}

module.exports = { getSetting, setSetting, getAllSettings, DEFAULTS };
