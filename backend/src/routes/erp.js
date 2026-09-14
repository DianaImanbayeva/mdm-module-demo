const express = require('express');
const router = express.Router();
const { fetchErpCandidates, fetchMeasuresList, SOURCE_TABLES } = require('../lib/erpClient');
const matching = require('../services/matchingService');
const bulkSync = require('../services/bulkSyncService');
const { requireSteward } = require('../middleware/auth');

// --- Массовая синхронизация всех справочников ERP через Движок Дедупликации
// (заменяет ручной построчный импорт — по просьбе: без отдельной вкладки,
// «Золотые записи» заполняются полностью сразу) ---
router.post('/sync-all', requireSteward, async (req, res) => {
    try {
        const result = await bulkSync.startSync({
            actor: req.user?.email,
            organizationId: req.user?.organizationId,
        });
        res.json(result);
    } catch (err) {
        console.error('[ERP SYNC-ALL ERROR]', err);
        res.status(500).json({ error: err.message });
    }
});

router.get('/sync-status', (req, res) => {
    res.json(bulkSync.getStatus());
});

// --- Синхронизация "снизу вверх": справочники Склада/Закупок (см. п. про
// "подключить данные из отдела продаж/складов/закупок") — их поставщики и
// номенклатура проходят через тот же Движок Дедупликации со своим
// source_system, чтобы ловить дубли между отделами ---
router.post('/sync-external/:connector', requireSteward, async (req, res) => {
    try {
        const result = await bulkSync.startExternalSync(req.params.connector, {
            actor: req.user?.email,
            organizationId: req.user?.organizationId,
        });
        res.json(result);
    } catch (err) {
        console.error('[EXTERNAL SYNC ERROR]', err);
        res.status(500).json({ error: err.message });
    }
});

// --- Справочник единиц измерения (erp.dic_measures) — для выпадающего списка
// на форме заявки вместо свободного текстового поля ---
router.get('/measures', async (req, res) => {
    try {
        res.json(await fetchMeasuresList());
    } catch (err) {
        console.error('[ERP MEASURES ERROR]', err);
        res.status(502).json({ error: 'Ошибка чтения справочника единиц измерения: ' + err.message });
    }
});

// --- Просмотр реальных данных ERP (ТОЛЬКО чтение, см. lib/erpClient.js) ---
// Позволяет вместо ручной эмуляции черновика выбрать настоящую строку из
// Materials_cas/Labor_cas/Machine_cas/contractors/project_objects и прогнать её
// через Движок Дедупликации, как это делал бы реальный поток mdm.raw.requests.
router.get('/candidates', async (req, res) => {
    try {
        const { entity_type, search = '', limit = '50', offset = '0' } = req.query;
        if (!SOURCE_TABLES[entity_type]) {
            return res.status(400).json({ error: `Неизвестный entity_type. Доступно: ${Object.keys(SOURCE_TABLES).join(', ')}` });
        }
        const rows = await fetchErpCandidates(entity_type, {
            limit: Math.min(Number(limit) || 50, 200),
            offset: Number(offset) || 0,
            search: String(search || ''),
        });
        res.json(rows);
    } catch (err) {
        console.error('[ERP CANDIDATES ERROR]', err);
        res.status(502).json({ error: 'Ошибка чтения из ERP: ' + err.message });
    }
});

// --- Импорт одной строки-кандидата из ERP как заявку в MDM (Стюард или прораб) ---
router.post('/import', async (req, res) => {
    try {
        const { entity_type, source_system, erp_id, name, unit } = req.body || {};
        if (!entity_type || !source_system || !erp_id || !name) {
            return res.status(400).json({ error: 'Обязательные поля: entity_type, source_system, erp_id, name' });
        }
        const result = await matching.processRequest({
            sourceSystem: source_system,
            localId: erp_id,
            entityType: entity_type,
            rawName: name,
            rawAttributes: unit ? { unit } : {},
            actor: req.user?.email,
            organizationId: req.user?.organizationId,
        });
        res.json(result);
    } catch (err) {
        console.error('[ERP IMPORT ERROR]', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
