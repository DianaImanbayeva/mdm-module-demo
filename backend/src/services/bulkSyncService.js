// Массовая синхронизация: прогоняет строки НСИ схемы "erp" (материалы,
// трудозатраты, машины, работы, общие ресурсы) через Движок Дедупликации разом,
// чтобы вкладка «Золотые записи» сразу показывала полный набор уникальных
// эталонов — без отдельной вкладки ручного импорта по одной позиции.
//
// Контрагенты и объекты строительства в этот набор намеренно не входят — в
// текущих данных ERP это единичные/тестовые записи, не настоящий справочник
// НСИ; при необходимости их можно прогнать отдельно через startSync({entityTypes:[...]}).
//
// Тысячи строк не проходят синхронно в рамках одного HTTP-запроса — задача
// запускается в фоне (см. startSync), а прогресс отдаётся через getStatus()
// для поллинга с фронтенда.
const matching = require('./matchingService');
const { fetchErpCandidates, countErpCandidates } = require('../lib/erpClient');
const warehouseClient = require('../lib/warehouseClient');
const procurementClient = require('../lib/procurementClient');
const costcasClient = require('../lib/costcasClient');

const DEFAULT_ENTITY_TYPES = ['material', 'labor', 'machine', 'job', 'resource'];
const SOURCE_SYSTEM = 'ERP_NSI';
const PAGE_SIZE = 200;
const CONCURRENCY = 8;

let job = null;

function getStatus() {
    return job ? job : { running: false };
}

async function runWithConcurrency(items, worker, concurrency) {
    let index = 0;
    async function lane() {
        while (index < items.length) {
            const current = items[index++];
            await worker(current);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
}

async function syncEntityType(entityType, actor, organizationId) {
    const stats = job.perType[entityType];
    let offset = 0;
    while (true) {
        const rows = await fetchErpCandidates(entityType, { limit: PAGE_SIZE, offset });
        if (!rows.length) break;

        await runWithConcurrency(rows, async (row) => {
            try {
                const result = await matching.processRequest({
                    sourceSystem: SOURCE_SYSTEM,
                    localId: row.erp_id,
                    entityType,
                    rawName: row.name,
                    rawAttributes: {
                        unit: row.unit || null,
                        article: row.code || null,
                        translations: row.translations || {},
                        unitTranslations: row.unitTranslations || {},
                    },
                    actor,
                    organizationId,
                });
                stats.processed++;
                stats[result.status] = (stats[result.status] || 0) + 1;
                job.totalProcessed++;
            } catch (err) {
                stats.errors++;
                console.error(`[BULK SYNC] ${entityType} ${row.erp_id}:`, err.message);
            }
        }, CONCURRENCY);

        if (rows.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }
}

async function startSync({ actor, organizationId, entityTypes } = {}) {
    if (job && job.running) return { alreadyRunning: true };

    const types = entityTypes && entityTypes.length ? entityTypes : DEFAULT_ENTITY_TYPES;
    const counts = await Promise.all(types.map(t => countErpCandidates(t)));

    job = {
        running: true,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        totalProcessed: 0,
        totalCount: counts.reduce((a, b) => a + b, 0),
        perType: Object.fromEntries(types.map((t, i) => [
            t, { total: counts[i], processed: 0, created: 0, merged: 0, conflict: 0, errors: 0 },
        ])),
    };

    (async () => {
        try {
            for (const t of types) {
                await syncEntityType(t, actor, organizationId);
            }
        } catch (err) {
            job.error = err.message;
        } finally {
            job.running = false;
            job.finishedAt = new Date().toISOString();
        }
    })();

    return { started: true, totalCount: job.totalCount };
}

// Синхронизация "снизу вверх": Склад, Закупки и CostCAS — не единственный
// источник правды (в отличие от erp/Сметы), а ДОПОЛНИТЕЛЬНЫЕ поставщики
// кандидатов — их справочники прогоняются через тот же Движок Дедупликации,
// с собственным source_system, чтобы Стюард видел, если один и тот же
// контрагент/материал/работа заведены по-разному в разных отделах/системах.
// CostCAS (16 тыс.+ работ) — того же порядка, что и erp, поэтому фоновая
// job-очередь общая с startSync (тот же объект job, см. getStatus).
const EXTERNAL_CONNECTORS = {
    warehouse: {
        sourceSystem: 'WAREHOUSE',
        fetchers: { contractor: warehouseClient.fetchSuppliers, material: warehouseClient.fetchCatalogItems },
    },
    procurement: {
        sourceSystem: 'PROCUREMENT',
        fetchers: { contractor: procurementClient.fetchSuppliers, material: procurementClient.fetchCatalogItems },
    },
    costcas: {
        sourceSystem: 'COSTCAS',
        fetchers: { job: costcasClient.fetchJobs, machine: costcasClient.fetchMachines, material: costcasClient.fetchMaterials },
    },
};

async function syncOneExternalType(sourceSystem, entityType, fetchFn, stats, actor, organizationId) {
    let offset = 0;
    while (true) {
        const rows = await fetchFn({ limit: PAGE_SIZE, offset });
        if (!rows.length) break;
        stats.total = (stats.total || 0) + rows.length;
        job.totalCount = Object.values(job.perType).reduce((sum, s) => sum + (s.total || 0), 0);

        await runWithConcurrency(rows, async (row) => {
            try {
                const result = await matching.processRequest({
                    sourceSystem,
                    localId: row.erp_id,
                    entityType,
                    rawName: row.name,
                    rawAttributes: { unit: row.unit || null, article: row.code || null },
                    actor,
                    organizationId,
                });
                stats.processed++;
                stats[result.status] = (stats[result.status] || 0) + 1;
                job.totalProcessed++;
            } catch (err) {
                stats.errors++;
                console.error(`[EXTERNAL SYNC] ${sourceSystem} ${entityType} ${row.erp_id}:`, err.message);
            }
        }, CONCURRENCY);

        if (rows.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }
}

async function startExternalSync(connectorKey, { actor, organizationId } = {}) {
    if (job && job.running) return { alreadyRunning: true };
    const connector = EXTERNAL_CONNECTORS[connectorKey];
    if (!connector) throw new Error(`Неизвестный источник: ${connectorKey}. Доступно: ${Object.keys(EXTERNAL_CONNECTORS).join(', ')}`);

    const types = Object.keys(connector.fetchers);
    // Точный total заранее неизвестен без отдельного count-запроса к каждому
    // источнику — считаем по мере поступления страниц (перезаписывается ниже).
    job = {
        running: true,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        totalProcessed: 0,
        totalCount: null,
        sourceSystem: connector.sourceSystem,
        perType: Object.fromEntries(types.map(t => [t, { total: null, processed: 0, merged: 0, conflict: 0, errors: 0 }])),
    };

    (async () => {
        try {
            for (const [entityType, fetchFn] of Object.entries(connector.fetchers)) {
                await syncOneExternalType(connector.sourceSystem, entityType, fetchFn, job.perType[entityType], actor, organizationId);
            }
        } catch (err) {
            job.error = err.message;
        } finally {
            job.running = false;
            job.finishedAt = new Date().toISOString();
        }
    })();

    return { started: true, sourceSystem: connector.sourceSystem };
}

module.exports = { startSync, getStatus, startExternalSync, EXTERNAL_CONNECTORS };
