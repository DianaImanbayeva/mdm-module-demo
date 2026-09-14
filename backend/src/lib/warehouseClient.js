// Источник кандидатов "снизу вверх": схема "warehouse" (Склад и Закупки) —
// тот же self-hosted Supabase, что и erp/mdm, просто другая схема. Читаем
// через общий клиент lib/pgrest.js (Accept-Profile: warehouse), только чтение.
const pg = require('./pgrest');

const SCHEMA = 'warehouse';

async function fetchSuppliers({ limit = 200, offset = 0 } = {}) {
    const rows = await pg.get(SCHEMA, 'erp_suppliers', {
        select: 'id,code,name,bin',
        limit: String(limit), offset: String(offset), order: 'id.asc',
    });
    return (rows || []).map(r => ({ erp_id: String(r.id), name: r.name, code: r.bin || r.code, unit: null }));
}

async function fetchCatalogItems({ limit = 200, offset = 0 } = {}) {
    const rows = await pg.get(SCHEMA, 'erp_catalog_items', {
        select: 'id,code,name,unit',
        limit: String(limit), offset: String(offset), order: 'id.asc',
    });
    return (rows || []).map(r => ({ erp_id: String(r.id), name: r.name, code: r.code, unit: r.unit || null }));
}

module.exports = { fetchSuppliers, fetchCatalogItems };
