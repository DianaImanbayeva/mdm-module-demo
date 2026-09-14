/**
 * Отправка действий MDM в общий журнал (модуль на 9010).
 *
 * Карта по коллекциям, а не по маршрутам: новый маршрут над уже известной
 * коллекцией попадёт в журнал сам, без правки этого файла.
 *
 * Инвентаризация по §6 ТЗ снята с src/routes/mdm.js и src/routes/erp.js.
 */

'use strict';

const { createJournalMiddleware } = require('../journal/express-journal');


// Код справочника в адресе -> как его называет человек.
//
// MDM ведёт мастер-данные строительства, и справочников ровно четыре. В адресе
// они стоят кодом (job, material), в интерфейсе и в разговоре - словом.
const CATALOG_TITLES = {
  job: 'Работы',
  material: 'Материалы',
  machine: 'Механизмы',
  contractor: 'Подрядчики',
};

const journalMiddleware = createJournalMiddleware({
  // Синхронизация и импорт - явными шаблонами: это загрузка данных извне
  // (IMPORT по §3.2), а карта по коллекциям вывела бы CREATE из метода POST.
  routes: [
    // Приём нажатий из браузера сам событием не является: записывать его
    // значило бы, что журнал описывает себя. И отказы пишутся даже на
    // неразмеченных маршрутах, поэтому просроченный пропуск в открытой вкладке
    // давал бы отказ на каждую отправку.
    { pattern: /^\/api\/v1\/journal\/ui$/, skip: true },
    { methods: 'POST', pattern: /^\/api\/v1\/erp\/sync-all$/, entityType: 'mdm_sync', action: 'IMPORT',
      title: 'Запустил полную синхронизацию мастер-данных со всеми системами-источниками' },
    { methods: 'POST', pattern: /^\/api\/v1\/erp\/sync-external\/([^/]+)$/, entityType: 'mdm_sync', action: 'IMPORT', idGroup: 1,
      title: (m) => `Запустил синхронизацию с системой-источником «${m[1]}»` },
    { methods: 'POST', pattern: /^\/api\/v1\/erp\/import$/, entityType: 'mdm_sync', action: 'IMPORT',
      title: 'Загрузил мастер-данные файлом' },

    // Настройка полей унификации.
    //
    // Без названия в журнале стояло «PUT /api/v1/unification-fields/job», и на
    // вопрос «что произошло» отвечал адрес обработчика. Справочник в адресе
    // назван кодом (job, material), а человек знает его как «Работы» и
    // «Материалы» - поэтому код переводится, а не подставляется как есть.
    { methods: ['PUT', 'PATCH'], pattern: /^\/api\/v1\/unification-fields\/([^/]+)$/,
      entityType: 'mdm_unification_field', action: 'UPDATE', idGroup: 1,
      title: (m) => `Настроил, по каким полям сводить дубли в справочнике «${CATALOG_TITLES[m[1]] || m[1]}»` },

    // Заявки на эталонное значение.
    { methods: 'POST', pattern: /^\/api\/v1\/requests\/([^/]+)\/resolve$/,
      entityType: 'mdm_request', action: 'APPROVE', idGroup: 1,
      title: 'Разрешил конфликт в заявке: выбрал эталонное значение' },
    { methods: 'POST', pattern: /^\/api\/v1\/requests$/, entityType: 'mdm_request', action: 'CREATE',
      title: 'Завёл заявку на изменение мастер-данных' },

    // Эталонные записи.
    { methods: 'POST', pattern: /^\/api\/v1\/golden-records$/, entityType: 'mdm_golden_record', action: 'CREATE',
      title: 'Создал эталонную запись' },
    { methods: ['PUT', 'PATCH'], pattern: /^\/api\/v1\/golden-records\/([^/]+)$/,
      entityType: 'mdm_golden_record', action: 'UPDATE', idGroup: 1,
      title: 'Изменил эталонную запись' },
    { methods: 'DELETE', pattern: /^\/api\/v1\/golden-records\/([^/]+)$/,
      entityType: 'mdm_golden_record', action: 'DELETE', idGroup: 1,
      title: 'Удалил эталонную запись' },

    { methods: ['PUT', 'PATCH', 'POST'], pattern: /^\/api\/v1\/settings$/,
      entityType: 'mdm_settings', action: 'UPDATE',
      title: 'Изменил настройки модуля: пороги чистоты и автослияния' },
  ],

  // MDM монтирует маршруты на /api/v1 и /api/v1/erp, поэтому 'erp' - сегмент
  // группировки, а не коллекция.
  stripPrefixes: ['/api/v1/', '/api/'],
  groupingSegments: ['erp'],

  entityByCollection: {
    'golden-records': 'mdm_golden_record',
    requests: 'mdm_request',
    settings: 'mdm_settings',
    'unification-fields': 'mdm_unification_field',
  },

  actionByVerb: {
    // Разрешение конфликта в заявке - это согласование эталонного значения.
    resolve: 'APPROVE',
  },

  skipCollections: ['health', 'dev', 'search', 'dashboard'],

  // Русские подписи полей, специфичных для мастер-данных.
  fieldLabels: {
    entity_type: 'тип сущности',
    entityType: 'тип сущности',
    source_system: 'система-источник',
    raw_name: 'исходное название',
    normalized_name: 'эталонное название',
    cleanliness_threshold: 'порог чистоты',
    autoMergeThreshold: 'порог автослияния',
    attributes: 'реквизиты',
    connector: 'коннектор',
    golden_record_id: 'эталонная запись',
    resolution: 'решение',
  },

  // req.user кладёт requireAuth: { id, email, role, organizationId }.
  actorFrom(req) {
    const user = req.user || {};
    return {
      actorId: String(user.id || user.email || ''),
      actorEmail: String(user.email || ''),
      actorName: String(user.email || ''),
      actorRole: String(user.role || ''),
      organizationId: String(user.organizationId || ''),
    };
  },
});

module.exports = { journalMiddleware };
