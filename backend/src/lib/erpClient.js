// Источник "сырых" кандидатов для дедупликации. Читает НАПРЯМУЮ схему "erp"
// (Accept-Profile: erp) через общий клиент lib/pgrest.js — только GET/SELECT,
// ничего сюда не пишется. Live-чтение, а не копия: у MDM нет своего снимка
// erp.Materials_cas и т.п. (см. supabase/001_mdm_schema.sql — mdm-схема
// хранит только рабочие таблицы самого модуля), поэтому данные не "протухают"
// и не нужно ничего пересинхронизировать.
const pg = require('./pgrest');

const ERP_SCHEMA = 'erp';
const LOCALES = ['ru', 'en', 'ka', 'az'];

const SOURCE_TABLES = {
    material: 'Materials_cas',
    labor: 'Labor_cas',
    machine: 'Machine_cas',
    job: 'jobs_cas',
    resource: 'resources',
    contractor: 'contractors',
    object: 'project_objects',
};

// jobs_norms_cas (нормы расхода — связка работа/материал/машина/труд + количество)
// сюда намеренно не входит: у неё нет собственного названия для сопоставления,
// это таблица связей, а не справочник номенклатуры.

// Переводы (ru/en/ka/az) объекта из erp.localization по его "полиморфной" связке
// object_id+object_name (а не по name_id — та FK отдаёт только одну, канонич.
// строку). Пачкой по списку id — чтобы не дёргать по одному запросу на строку.
async function fetchTranslationsBatch(objectName, ids) {
    if (!ids.length) return {};
    const rows = await pg.get(ERP_SCHEMA, 'localization', {
        select: 'object_id,locale,name',
        object_id: `in.(${ids.join(',')})`,
        object_name: `eq.${objectName}`,
    });
    const map = {};
    for (const r of rows || []) {
        if (!LOCALES.includes(r.locale)) continue;
        (map[r.object_id] || (map[r.object_id] = {}))[r.locale] = r.name;
    }
    return map;
}

// Справочник единиц измерения целиком (их всего 44) — с переводами на все
// локали. Читается один раз в начале синхронизации и переиспользуется.
let measuresCache = null;
async function loadMeasures() {
    if (measuresCache) return measuresCache;
    const rows = await pg.get(ERP_SCHEMA, 'dic_measures', { select: 'id,code' });
    const ids = (rows || []).map(r => r.id);
    const translationsById = await fetchTranslationsBatch('dic_measures', ids);
    measuresCache = {};
    for (const r of rows || []) {
        measuresCache[r.id] = { code: r.code, translations: translationsById[r.id] || {} };
    }
    return measuresCache;
}

async function fetchErpCandidates(entityType, { limit = 50, offset = 0, search = '' } = {}) {
    const table = SOURCE_TABLES[entityType];
    if (!table) throw new Error(`Неизвестный тип сущности: ${entityType}`);

    if (entityType === 'contractor') {
        const params = {
            select: 'id,company_name,bin_iin,is_active',
            is_active: 'eq.true',
            limit: String(limit), offset: String(offset), order: 'company_name.asc',
        };
        if (search) params.company_name = `ilike.*${search}*`;
        const rows = await pg.get(ERP_SCHEMA, table, params);
        return (rows || []).map(r => ({ erp_id: r.id, name: r.company_name, code: r.bin_iin, unit: null, translations: {}, unitTranslations: {} }));
    }

    if (entityType === 'object') {
        const params = {
            select: 'id,name,address',
            limit: String(limit), offset: String(offset), order: 'name.asc',
        };
        if (search) params.name = `ilike.*${search}*`;
        const rows = await pg.get(ERP_SCHEMA, table, params);
        return (rows || []).map(r => ({ erp_id: r.id, name: r.name, code: null, unit: null, translations: {}, unitTranslations: {} }));
    }

    // material | labor | machine | job | resource — общая структура
    // (code, localization(name), measure_id -> dic_measures.code)
    const params = {
        select: 'id,code,is_active,measure_id,localization(name)',
        is_active: 'eq.true',
        limit: String(limit), offset: String(offset), order: 'code.asc',
    };
    if (search) params['localization.name'] = `ilike.*${search}*`;
    // Партия ресурсов с артикулами "PB.*" — известно битые переводы en/ka
    // ("Dusbin.service" и т.п., слова через точку без пробелов). Убрана из
    // золотых записей вручную; здесь исключается навсегда, чтобы не
    // возвращалась при повторной синхронизации.
    if (entityType === 'resource') params.code = 'not.like.PB.*';
    const rows = (await pg.get(ERP_SCHEMA, table, params) || []).filter(r => r.localization && r.localization.name);

    const [translationsById, measures] = await Promise.all([
        fetchTranslationsBatch(table, rows.map(r => r.id)),
        loadMeasures(),
    ]);

    return rows.map(r => {
        const measure = r.measure_id ? measures[r.measure_id] : null;
        return {
            erp_id: r.id,
            name: r.localization.name,
            code: r.code,
            unit: measure ? measure.code : null,
            translations: translationsById[r.id] || {},
            unitTranslations: measure ? measure.translations : {},
        };
    });
}

// Точное количество строк по типу — нужно для прогресса массовой синхронизации
// (services/bulkSyncService.js), а не для отображения списка.
async function countErpCandidates(entityType) {
    const table = SOURCE_TABLES[entityType];
    if (!table) throw new Error(`Неизвестный тип сущности: ${entityType}`);

    if (entityType === 'contractor') {
        return pg.count(ERP_SCHEMA, table, { select: 'id', is_active: 'eq.true' });
    }
    if (entityType === 'object') {
        return pg.count(ERP_SCHEMA, table, { select: 'id' });
    }
    const params = { select: 'id', is_active: 'eq.true' };
    if (entityType === 'resource') params.code = 'not.like.PB.*';
    return pg.count(ERP_SCHEMA, table, params);
}

// Список единиц измерения (код + переводы) для выпадающего списка на форме
// заявки — вместо свободного текстового поля, как просили.
async function fetchMeasuresList() {
    const map = await loadMeasures();
    return Object.values(map).sort((a, b) => (a.translations.ru || a.code).localeCompare(b.translations.ru || b.code, 'ru'));
}

module.exports = { fetchErpCandidates, countErpCandidates, fetchMeasuresList, SOURCE_TABLES };
