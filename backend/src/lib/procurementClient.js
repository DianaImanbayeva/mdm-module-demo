// Источник кандидатов "снизу вверх": Закупки (и Склад — та же база) со своим
// отдельным облачным Supabase-проектом (см. C:\procurement\.env), не тот
// self-hosted инстанс, где живут erp/warehouse/mdm. Только чтение — как и
// erpClient.js, сюда ничего не пишется.
const { procurementSupabaseUrl, procurementSupabaseServiceRoleKey } = require('../config/env');

async function get(path, params = {}) {
    if (!procurementSupabaseUrl || !procurementSupabaseServiceRoleKey) {
        throw new Error('PROCUREMENT_SUPABASE_URL / PROCUREMENT_SUPABASE_SERVICE_ROLE_KEY не заданы в .env');
    }
    const url = new URL(`${procurementSupabaseUrl}/rest/v1/${path}`);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
    const res = await fetch(url, {
        headers: {
            apikey: procurementSupabaseServiceRoleKey,
            Authorization: `Bearer ${procurementSupabaseServiceRoleKey}`,
        },
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Procurement Supabase GET ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json();
}

// Поставщики -> кандидаты для entity_type "contractor" (ИИН/БИН уже есть в
// поле "bin" — та же семантика, что и article для контрагента в MDM, см. п.5
// "поля унификации").
async function fetchSuppliers({ limit = 200, offset = 0 } = {}) {
    const rows = await get('erp_suppliers', {
        select: 'id,code,name,bin',
        limit: String(limit), offset: String(offset), order: 'id.asc',
    });
    return (rows || []).map(r => ({ erp_id: String(r.id), name: r.name, code: r.bin || r.code, unit: null }));
}

// Номенклатура -> кандидаты для entity_type "material".
async function fetchCatalogItems({ limit = 200, offset = 0 } = {}) {
    const rows = await get('erp_catalog_items', {
        select: 'id,code,name,unit',
        limit: String(limit), offset: String(offset), order: 'id.asc',
    });
    return (rows || []).map(r => ({ erp_id: String(r.id), name: r.name, code: r.code, unit: r.unit || null }));
}

module.exports = { fetchSuppliers, fetchCatalogItems };
