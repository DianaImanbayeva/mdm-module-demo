// Конфиг "полей унификации" (п.5 из списка руководителя) — по каким полям
// сущность считается ТОЧНО той же самой, независимо от нечёткого сходства
// названия. Кеш по той же схеме, что и mdm_settings.js: сотни/тысячи запросов
// при массовой синхронизации не должны каждый раз ходить в БД.
const pg = require('../lib/pgrest');
const { mdmSchema } = require('../config/env');

const ALLOWED_FIELDS = ['article', 'normalized_name'];

let cache = null;

async function loadAll() {
    if (cache) return cache;
    const rows = await pg.get(mdmSchema, 'mdm_unification_fields', { select: 'entity_type,fields' });
    cache = {};
    for (const r of rows || []) cache[r.entity_type] = r.fields || [];
    return cache;
}

async function getUnificationFields(entityType) {
    const all = await loadAll();
    return all[entityType] || [];
}

async function getAllUnificationFields() {
    return loadAll();
}

async function setUnificationFields(entityType, fields, updatedBy) {
    const clean = [...new Set((fields || []).filter(f => ALLOWED_FIELDS.includes(f)))];
    await pg.post(mdmSchema, 'mdm_unification_fields',
        { entity_type: entityType, fields: clean, updated_by: updatedBy || null, updated_at: new Date().toISOString() },
        'resolution=merge-duplicates,return=minimal');
    if (!cache) await loadAll();
    cache[entityType] = clean;
    return clean;
}

module.exports = { ALLOWED_FIELDS, getUnificationFields, getAllUnificationFields, setUnificationFields };
