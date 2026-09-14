const express = require('express');
const router = express.Router();
const pg = require('../lib/pgrest');
const { mdmSchema } = require('../config/env');
const matching = require('../services/matchingService');
const { requireSteward } = require('../middleware/auth');
const { recentEvents } = require('../lib/eventBus');
const { fetchMeasuresList } = require('../lib/erpClient');
const { getAllSettings, setSetting } = require('../lib/settings');
const { ALLOWED_FIELDS, getAllUnificationFields, setUnificationFields } = require('../lib/unificationConfig');

// --- Настраиваемые параметры движка ("порог чистоты" и т.п.) ---
router.get('/settings', async (req, res) => {
    try {
        res.json(await getAllSettings());
    } catch (err) {
        console.error('[MDM SETTINGS GET ERROR]', err);
        res.status(500).json({ error: err.message });
    }
});

router.patch('/settings', requireSteward, async (req, res) => {
    try {
        const { cleanliness_threshold } = req.body || {};
        if (cleanliness_threshold !== undefined) {
            const v = Number(cleanliness_threshold);
            if (!Number.isFinite(v) || v < 0 || v > 1) {
                return res.status(400).json({ error: 'cleanliness_threshold должен быть числом от 0 до 1' });
            }
            await setSetting('cleanliness_threshold', v, req.user?.email);
        }
        res.json(await getAllSettings());
    } catch (err) {
        console.error('[MDM SETTINGS PATCH ERROR]', err);
        res.status(500).json({ error: err.message });
    }
});

// --- П.5: "поля унификации" — по каким полям сущность считается точно той
// же самой (ИИН/БИН для контрагента, код+название для вида работ и т.п.) ---
router.get('/unification-fields', async (req, res) => {
    try {
        res.json({ allowedFields: ALLOWED_FIELDS, byEntityType: await getAllUnificationFields() });
    } catch (err) {
        console.error('[MDM UNIFICATION FIELDS GET ERROR]', err);
        res.status(500).json({ error: err.message });
    }
});

router.put('/unification-fields/:entityType', requireSteward, async (req, res) => {
    try {
        const { fields } = req.body || {};
        if (!Array.isArray(fields)) return res.status(400).json({ error: 'fields должен быть массивом' });
        const saved = await setUnificationFields(req.params.entityType, fields, req.user?.email);
        res.json({ entityType: req.params.entityType, fields: saved });
    } catch (err) {
        console.error('[MDM UNIFICATION FIELDS PUT ERROR]', err);
        res.status(500).json({ error: err.message });
    }
});

// Перевод выбранной единицы измерения по её коду (dic_measures) — чтобы у
// эталонов, заведённых вручную (утверждение заявки / прямое создание), тоже
// был переведённый вид единицы, как у пришедших из массовой синхронизации.
async function unitTranslationsFor(code) {
    if (!code) return {};
    const measures = await fetchMeasuresList();
    return measures.find(m => m.code === code)?.translations || {};
}

// --- Дашборд (АРМ Методолога НСИ, п.8 ТЗ) ---
router.get('/dashboard', async (req, res) => {
    try {
        const { date_from, date_to } = req.query;
        const [stats, busEvents] = await Promise.all([matching.dashboardStats({ dateFrom: date_from, dateTo: date_to }), recentEvents(10)]);
        res.json({ ...stats, busEvents });
    } catch (err) {
        console.error('[MDM DASHBOARD ERROR]', err);
        res.status(500).json({ error: err.message });
    }
});

// --- Живой поиск похожих эталонов (подсказка во время ввода названия) ---
router.get('/search', async (req, res) => {
    try {
        const { entity_type, q } = req.query;
        if (!entity_type || !q || !String(q).trim()) return res.json([]);
        const results = (await matching.findSimilar(entity_type, q, 5)).filter(r => r.score >= 0.15);
        res.json(results);
    } catch (err) {
        console.error('[MDM SEARCH ERROR]', err);
        res.status(500).json({ error: err.message });
    }
});

// --- Список заявок ---
router.get('/requests', async (req, res) => {
    try {
        const { status, entity_type, source_system, local_id, date_from, date_to, page = '1', limit = '50' } = req.query;
        const filters = {};
        if (status) filters.status = `eq.${status}`;
        if (entity_type) filters.entity_type = `eq.${entity_type}`;
        // source_system/local_id — для других модулей экосистемы (см. п.7:
        // Смета проверяет статус своей же заявки по тому local_id, которым
        // её создавала, без хранения дублирующего состояния у себя).
        if (source_system) filters.source_system = `eq.${source_system}`;
        if (local_id) filters.local_id = `eq.${local_id}`;
        // Фильтр по периоду (за неделю/месяц/весь период/свой диапазон) — обе
        // границы на одном ключе "and", иначе вторая перезаписала бы первую
        // (created_at не может встретиться дважды как отдельный ключ параметров).
        const period = [];
        if (date_from) period.push(`created_at.gte.${date_from}`);
        if (date_to) period.push(`created_at.lte.${date_to}`);
        if (period.length) filters.and = `(${period.join(',')})`;

        // Пагинация — при десятках тысяч заявок один запрос без offset отдавал
        // только первые 200 по дате создания, из-за чего старые (например,
        // "Конфликт" из давней массовой синхронизации) были вообще не видны,
        // если недавняя активность заполнила эти 200 слотов свежими "Слито".
        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const pageSize = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
        const [rows, total] = await Promise.all([
            pg.get(mdmSchema, 'mdm_requests', { ...filters, select: '*', order: 'created_at.desc', limit: String(pageSize), offset: String((pageNum - 1) * pageSize) }),
            pg.count(mdmSchema, 'mdm_requests', { ...filters, select: 'id' }),
        ]);
        res.json({ rows: rows || [], total, page: pageNum, pageSize });
    } catch (err) {
        console.error('[MDM REQUESTS LIST ERROR]', err);
        res.status(500).json({ error: err.message });
    }
});

// --- Одна заявка целиком (карточка заявки) ---
router.get('/requests/:id', async (req, res) => {
    try {
        const reqRow = await matching.getRequest(req.params.id);
        if (!reqRow) return res.status(404).json({ error: 'Не найдено' });

        let golden = null;
        if (reqRow.resolved_golden_id) golden = await matching.getGoldenRecord(reqRow.resolved_golden_id);

        res.json({ ...reqRow, golden });
    } catch (err) {
        console.error('[MDM REQUEST DETAIL ERROR]', err);
        res.status(500).json({ error: err.message });
    }
});

// --- Новая заявка (Процесс А из ТЗ: черновик -> Движок Дедупликации ->
// merged | created | conflict). Ветвь "создан новый эталон" срабатывает сразу
// и автоматически — как описано в ТЗ, без промежуточного утверждения. ---
router.post('/requests', async (req, res) => {
    try {
        const { source_system, local_id, entity_type, raw_name, raw_attributes } = req.body || {};
        if (!source_system || !entity_type || !raw_name) {
            return res.status(400).json({ error: 'Обязательные поля: source_system, entity_type, raw_name' });
        }
        const result = await matching.processRequest({
            sourceSystem: source_system,
            localId: local_id,
            entityType: entity_type,
            rawName: raw_name,
            rawAttributes: raw_attributes,
            actor: req.user?.email,
            organizationId: req.user?.organizationId,
        });
        res.json(result);
    } catch (err) {
        console.error('[MDM REQUEST CREATE ERROR]', err);
        res.status(500).json({ error: err.message });
    }
});

// --- Ручное разрешение конфликта (АРМ "Разрешение конфликтов", доступно только Стюарду) ---
router.post('/requests/:id/resolve', requireSteward, async (req, res) => {
    try {
        const { action, golden_id } = req.body || {};
        const updated = await matching.resolveConflict(req.params.id, {
            action,
            goldenId: golden_id,
            resolvedBy: req.user?.email || 'стюард данных',
            organizationId: req.user?.organizationId,
        });
        res.json(updated);
    } catch (err) {
        console.error('[MDM RESOLVE ERROR]', err);
        res.status(400).json({ error: err.message });
    }
});

// --- Прямое заведение эталона Стюардом (Процесс Б из ТЗ: без черновика, мгновенный global_guid) ---
router.post('/golden-records', requireSteward, async (req, res) => {
    try {
        const { entity_type, normalized_name, article, material_group, base_unit } = req.body || {};
        if (!entity_type || !normalized_name) {
            return res.status(400).json({ error: 'Обязательные поля: entity_type, normalized_name' });
        }
        const golden = await matching.createGoldenRecord({
            entityType: entity_type,
            normalizedName: matching.normalizeName(normalized_name),
            article: article || null,
            materialGroup: material_group || null,
            baseUnit: base_unit || null,
            unitTranslations: await unitTranslationsFor(base_unit),
        });
        await matching.audit('created', {
            goldenId: golden.id, actor: req.user?.email, organizationId: req.user?.organizationId,
            details: { via: 'direct', process: 'Процесс Б (Центр экспертизы)' },
        });
        res.json(golden);
    } catch (err) {
        console.error('[MDM GOLDEN CREATE ERROR]', err);
        res.status(500).json({ error: err.message });
    }
});

// --- Золотые записи (для редактора/просмотра) ---
router.get('/golden-records', async (req, res) => {
    try {
        const { entity_type, search, page = '1', limit = '50' } = req.query;
        const filters = { status: 'eq.active' };
        if (entity_type) filters.entity_type = `eq.${entity_type}`;
        if (search && search.trim()) filters.normalized_name = `ilike.*${matching.normalizeName(search)}*`;

        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const pageSize = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
        const [rows, total] = await Promise.all([
            pg.get(mdmSchema, 'mdm_golden_records', { ...filters, select: '*', order: 'created_at.desc', limit: String(pageSize), offset: String((pageNum - 1) * pageSize) }),
            pg.count(mdmSchema, 'mdm_golden_records', { ...filters, select: 'id' }),
        ]);
        res.json({ rows: rows || [], total, page: pageNum, pageSize });
    } catch (err) {
        console.error('[MDM GOLDEN LIST ERROR]', err);
        res.status(500).json({ error: err.message });
    }
});

// --- Удаление эталона (Стюард) — мягкое: запись архивируется и пропадает
// из списков, история/cross-reference не ломаются ---
router.delete('/golden-records/:id', requireSteward, async (req, res) => {
    try {
        await matching.archiveGoldenRecord(req.params.id, {
            actor: req.user?.email,
            organizationId: req.user?.organizationId,
        });
        res.json({ ok: true });
    } catch (err) {
        console.error('[MDM GOLDEN DELETE ERROR]', err);
        res.status(400).json({ error: err.message });
    }
});

router.get('/golden-records/:id', async (req, res) => {
    try {
        const golden = await matching.getGoldenRecord(req.params.id);
        if (!golden) return res.status(404).json({ error: 'Не найдено' });

        const [crossReferences, history, auditLog] = await Promise.all([
            pg.get(mdmSchema, 'mdm_cross_reference', { golden_id: `eq.${req.params.id}`, select: '*' }),
            pg.get(mdmSchema, 'mdm_requests', {
                resolved_golden_id: `eq.${req.params.id}`,
                select: 'id,source_system,raw_name,translations,status,created_at,resolved_at,resolved_by',
                order: 'created_at.desc',
            }),
            pg.get(mdmSchema, 'mdm_audit_log', {
                golden_id: `eq.${req.params.id}`,
                select: 'id,action,actor,organization_id,details,created_at',
                order: 'created_at.desc',
            }),
        ]);

        res.json({ ...golden, crossReferences: crossReferences || [], history: history || [], auditLog: auditLog || [] });
    } catch (err) {
        console.error('[MDM GOLDEN DETAIL ERROR]', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
