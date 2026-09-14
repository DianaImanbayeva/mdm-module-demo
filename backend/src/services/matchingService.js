const pg = require('../lib/pgrest');
const { publish, TOPICS } = require('../lib/eventBus');
const { mdmSchema } = require('../config/env');
const { levenshteinSimilarity } = require('../lib/levenshtein');
const { jaroWinklerSimilarity } = require('../lib/jaroWinkler');
const { getSetting } = require('../lib/settings');
const { getUnificationFields } = require('../lib/unificationConfig');

// "Порог чистоты" — настраиваемый параметр (не хардкод), см. mdm_settings.
// >= порог  -> совпадение "чистое", автослияние с найденным эталоном.
// <  порог  -> "грязное" — эталон НЕ создаётся автоматически, заявка уходит
//              оператору: он либо выбирает эталон из кандидатов, либо сам
//              подтверждает, что это действительно новая позиция (create_new
//              в resolveConflict). Раньше был третий, полностью автоматический
//              путь создания нового эталона без участия человека — отключён
//              по прямому запросу: "грязное чистится только через заявку".

function normalizeName(raw) {
    return String(raw || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Настоящий pg_trgm (функция mdm.mdm_find_similar из supabase/001_mdm_schema.sql)
// даёт первичный список кандидатов. Дальше на этот же список накладывается
// вторая, независимая метрика — расстояние Левенштейна (см. "нечеткий
// поиск.pdf") — и по обеим считается процент. Обе метрики ловят разные
// несовпадения: pg_trgm — общий набор трёхбуквенных кусочков, Левенштейн —
// точное число посимвольных правок. score остаётся полем для порогов
// автослияния/конфликта (без изменений), levenshtein_score — только для
// сравнения Стюардом в форме заявки, на решение не влияет.
// Подтягивает translations эталонов по списку id — используется и для свежих
// кандидатов из mdm_find_similar (у него в ответе только id/normalized_name/score),
// и для candidates, уже сохранённых в старых заявках (там translations вообще
// не было на момент создания — довешиваем их "на лету" при чтении, без
// массовой миграции по всем заявкам).
async function attachTranslations(items) {
    if (!items || items.length === 0) return items || [];
    const ids = [...new Set(items.map(i => i.id))];
    const rows = await pg.get(mdmSchema, 'mdm_golden_records', {
        id: `in.(${ids.join(',')})`, select: 'id,translations',
    });
    const translationsById = new Map((rows || []).map(g => [g.id, g.translations]));
    return items.map(i => ({ ...i, translations: translationsById.get(i.id) || i.translations || {} }));
}

// Кандидаты, сохранённые в заявках из самой первой массовой синхронизации
// (до того, как в движок добавили метрики LEV/JW), в базе так и остались без
// этих полей. Досчитываем их так же, "на лету" при открытии карточки —
// нормализованное имя заявки уже известно на момент вызова, пересчёт трёх
// кандидатов ничего не стоит.
async function enrichCandidates(candidates, normalizedRequestName) {
    const withTranslations = await attachTranslations(candidates);
    return withTranslations.map(c => ({
        ...c,
        levenshtein_score: c.levenshtein_score != null
            ? c.levenshtein_score
            : Number(levenshteinSimilarity(normalizedRequestName, c.normalized_name).toFixed(4)),
        jaro_winkler_score: c.jaro_winkler_score != null
            ? c.jaro_winkler_score
            : Number(jaroWinklerSimilarity(normalizedRequestName, c.normalized_name).toFixed(4)),
    }));
}

async function findSimilar(entityType, name, limit = 5) {
    const normalized = normalizeName(name);
    const rows = await pg.rpc(mdmSchema, 'mdm_find_similar', {
        p_entity_type: entityType,
        p_name: normalized,
        p_limit: limit,
    });
    if (!rows || rows.length === 0) return [];

    return attachTranslations(rows.map(r => ({
        ...r,
        levenshtein_score: Number(levenshteinSimilarity(normalized, r.normalized_name).toFixed(4)),
        jaro_winkler_score: Number(jaroWinklerSimilarity(normalized, r.normalized_name).toFixed(4)),
    })));
}

async function createGoldenRecord({ entityType, normalizedName, article = null, materialGroup = null, baseUnit = null, translations = {}, unitTranslations = {} }) {
    const [golden] = await pg.post(mdmSchema, 'mdm_golden_records', {
        entity_type: entityType,
        normalized_name: normalizedName,
        article,
        material_group: materialGroup,
        base_unit: baseUnit,
        translations,
        unit_translations: unitTranslations,
    });
    return golden;
}

async function getGoldenRecord(id) {
    const rows = await pg.get(mdmSchema, 'mdm_golden_records', { id: `eq.${id}`, select: '*' });
    return rows?.[0] || null;
}

// Мягкое удаление — запись перестаёт быть "active" и пропадает из списков
// (GET /golden-records уже фильтрует status=eq.active), но остаётся в базе:
// история заявок и cross-reference, которые на неё ссылаются, не ломаются.
async function archiveGoldenRecord(id, { actor = null, organizationId = null } = {}) {
    const golden = await getGoldenRecord(id);
    if (!golden) throw new Error('Эталон не найден');

    const [updated] = await pg.patch(mdmSchema, 'mdm_golden_records', { id: `eq.${id}` }, { status: 'archived' });
    await audit('archived', { goldenId: id, actor, organizationId, details: { normalized_name: golden.normalized_name } });
    return updated;
}

async function upsertCrossReference(goldenId, systemCode, localSystemId) {
    if (!localSystemId) return;
    await pg.post(
        mdmSchema,
        'mdm_cross_reference',
        { golden_id: goldenId, system_code: systemCode, local_system_id: String(localSystemId) },
        'resolution=ignore-duplicates,return=minimal'
    );
}

async function audit(action, { goldenId = null, actor = null, organizationId = null, details = {} } = {}) {
    await pg.post(mdmSchema, 'mdm_audit_log', {
        golden_id: goldenId, action, actor, organization_id: organizationId, details,
    }, 'return=minimal');
}

async function getRequest(id) {
    const rows = await pg.get(mdmSchema, 'mdm_requests', { id: `eq.${id}`, select: '*' });
    const request = rows?.[0] || null;
    if (request?.candidates?.length) {
        request.candidates = await enrichCandidates(request.candidates, normalizeName(request.raw_name));
    }
    return request;
}

// П.5 из списка руководителя: "поля унификации" — для настроенных entity_type
// (см. mdm_unification_fields) сущность считается ТОЧНО той же самой, если
// совпадают все выбранные поля (например article=ИИН/БИН для контрагента,
// или article+normalized_name для вида работ — оба должны совпасть, иначе
// одинаковый код у двух разных по факту работ склеил бы их в одну). Это
// отдельная, более сильная проверка ПЕРЕД нечётким pg_trgm-сравнением: если
// найдено точное совпадение по ключу — дальше нечёткий скор не важен.
async function findExactMatch(entityType, normalizedName, rawAttributes) {
    const fields = await getUnificationFields(entityType);
    if (!fields.length) return null;

    const params = { entity_type: `eq.${entityType}`, status: 'eq.active', select: 'id,normalized_name,translations', limit: '1' };
    for (const field of fields) {
        const value = field === 'normalized_name' ? normalizedName : rawAttributes?.[field];
        if (value == null || String(value).trim() === '') return null; // без значения ключевого поля точное совпадение не заявляем
        params[field] = `eq.${value}`;
    }
    const rows = await pg.get(mdmSchema, 'mdm_golden_records', params);
    return rows?.[0] || null;
}

async function findExistingRequest(sourceSystem, localId) {
    if (!localId) return null;
    const rows = await pg.get(mdmSchema, 'mdm_requests', {
        source_system: `eq.${sourceSystem}`, local_id: `eq.${localId}`, select: '*', limit: '1',
    });
    return rows?.[0] || null;
}

// Процесс А из ТЗ: черновик -> Движок Дедупликации -> merged | conflict.
// Идемпотентность: если для этой же пары (source_system, local_id) заявка уже
// заведена — она просто возвращается как есть, повторно не создаётся. Без этой
// проверки повторный запуск массовой синхронизации плодил вторую (третью...)
// копию заявки-конфликта на ту же самую строку ERP при каждом нажатии кнопки.
async function processRequest({ sourceSystem, localId, entityType, rawName, rawAttributes = {}, actor = null, organizationId = null }) {
    const existing = await findExistingRequest(sourceSystem, localId);
    if (existing) return existing;

    const normalized = normalizeName(rawName);
    const exactMatch = await findExactMatch(entityType, normalized, rawAttributes);
    const candidates = await findSimilar(entityType, normalized, 3);
    const top = candidates[0];
    const topScore = top ? Number(top.score) : 0;
    const cleanlinessThreshold = await getSetting('cleanliness_threshold');

    await publish(TOPICS.RAW_REQUESTS, { local_id: localId, source_system: sourceSystem, entity_type: entityType, raw_name: rawName });

    let status, matchGoldenId = null, resolvedGoldenId = null, resolvedAt = null, resolvedBy = null, matchScore = topScore, matchedVia = null;

    if (exactMatch) {
        // Точное совпадение по полю(-ям) унификации — сильнее любого нечёткого
        // скора, порог чистоты здесь ни при чём (см. mdm_unification_fields).
        status = 'merged';
        matchGoldenId = exactMatch.id;
        resolvedGoldenId = exactMatch.id;
        resolvedAt = new Date().toISOString();
        resolvedBy = 'system (auto, unification key)';
        matchScore = 1;
        matchedVia = 'unification_field';
    } else if (topScore >= cleanlinessThreshold) {
        status = 'merged';
        matchGoldenId = top.id;
        resolvedGoldenId = top.id;
        resolvedAt = new Date().toISOString();
        resolvedBy = 'system (auto)';
    } else {
        // "Грязное" совпадение — эталон НЕ создаётся автоматически, заявка
        // ждёт оператора (см. resolveConflict: merge с кандидатом или create_new).
        status = 'conflict';
    }

    const [request] = await pg.post(mdmSchema, 'mdm_requests', {
        source_system: sourceSystem, local_id: localId || null, entity_type: entityType,
        raw_name: rawName, raw_attributes: rawAttributes || {}, status,
        match_golden_id: matchGoldenId, match_score: matchScore, candidates,
        resolved_golden_id: resolvedGoldenId, resolved_at: resolvedAt, resolved_by: resolvedBy,
        translations: rawAttributes?.translations || {},
        submitted_by: actor || null,
    });

    if (resolvedGoldenId && localId) {
        await upsertCrossReference(resolvedGoldenId, sourceSystem, localId);
    }
    if (status === 'merged') {
        await audit('merged', { goldenId: resolvedGoldenId, actor: actor || 'system', organizationId, details: { via: matchedVia || 'auto', match_score: matchScore, source_system: sourceSystem } });
        await publish(TOPICS.GOLDEN_UPDATES, { global_guid: resolvedGoldenId, merged_local_id: localId, source_system: sourceSystem });
    }

    return request;
}

// Разрешение конфликта Стюардом: слить с конкретным кандидатом либо создать новый эталон.
async function resolveConflict(requestId, { action, goldenId, resolvedBy, organizationId }) {
    const reqRow = await getRequest(requestId);
    if (!reqRow) throw new Error('Заявка не найдена');
    if (reqRow.status !== 'conflict') throw new Error('Эта заявка не в статусе конфликта');

    let finalGoldenId;
    if (action === 'merge') {
        if (!goldenId) throw new Error('Не указан golden_id для слияния');
        finalGoldenId = goldenId;
    } else if (action === 'create_new') {
        const golden = await createGoldenRecord({
            entityType: reqRow.entity_type,
            normalizedName: normalizeName(reqRow.raw_name),
            article: reqRow.raw_attributes?.article || null,
            baseUnit: reqRow.raw_attributes?.unit || null,
            translations: reqRow.raw_attributes?.translations || {},
            unitTranslations: reqRow.raw_attributes?.unitTranslations || {},
        });
        finalGoldenId = golden.id;
        await publish(TOPICS.GOLDEN_UPDATES, { global_guid: golden.id, entity_type: reqRow.entity_type });
    } else {
        throw new Error("action должен быть 'merge' или 'create_new'");
    }

    const resolvedAt = new Date().toISOString();
    const [updated] = await pg.patch(mdmSchema, 'mdm_requests', { id: `eq.${requestId}` }, {
        status: action === 'merge' ? 'merged' : 'created',
        resolved_golden_id: finalGoldenId,
        resolved_at: resolvedAt,
        resolved_by: resolvedBy || 'стюард данных',
    });

    if (reqRow.local_id) {
        await upsertCrossReference(finalGoldenId, reqRow.source_system, reqRow.local_id);
    }

    await audit(action === 'merge' ? 'merged' : 'created', {
        goldenId: finalGoldenId, actor: resolvedBy, organizationId,
        details: { via: 'manual', request_id: requestId, source_system: reqRow.source_system },
    });
    await publish(TOPICS.GOLDEN_UPDATES, { global_guid: finalGoldenId, resolved_request_id: requestId });

    return updated;
}

// dateFrom/dateTo — период для карточек на дашборде (за неделю/месяц/весь
// период/свой диапазон), фильтрует именно счётчики заявок за это время;
// "Всего эталонов" — сквозной итог, периодом не режется (это не событие,
// а текущее состояние справочника).
async function dashboardStats({ dateFrom, dateTo } = {}) {
    const period = [];
    if (dateFrom) period.push(`created_at.gte.${dateFrom}`);
    if (dateTo) period.push(`created_at.lte.${dateTo}`);
    const periodFilter = period.length ? { and: `(${period.join(',')})` } : {};

    const [queueNew, queueConflict, mergedCount, createdCount, totalGolden] = await Promise.all([
        pg.count(mdmSchema, 'mdm_requests', { select: 'id', status: 'eq.new', ...periodFilter }),
        pg.count(mdmSchema, 'mdm_requests', { select: 'id', status: 'eq.conflict', ...periodFilter }),
        pg.count(mdmSchema, 'mdm_requests', { select: 'id', status: 'eq.merged', ...periodFilter }),
        pg.count(mdmSchema, 'mdm_requests', { select: 'id', status: 'eq.created', ...periodFilter }),
        pg.count(mdmSchema, 'mdm_golden_records', { select: 'id', status: 'eq.active' }),
    ]);

    const processed = mergedCount + createdCount + queueConflict;
    const autoMergeRatePct = processed > 0 ? Math.round(((mergedCount + createdCount) / processed) * 100) : 0;
    const manualConflictRatePct = processed > 0 ? Math.round((queueConflict / processed) * 100) : 0;

    return { queueNew, queueConflict, totalGoldenRecords: totalGolden, autoMergeRatePct, manualConflictRatePct };
}

module.exports = {
    normalizeName,
    findSimilar,
    createGoldenRecord,
    getGoldenRecord,
    archiveGoldenRecord,
    getRequest,
    processRequest,
    resolveConflict,
    dashboardStats,
    audit,
};
