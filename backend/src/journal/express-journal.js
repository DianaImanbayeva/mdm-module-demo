/**
 * Middleware Express для отправки действий в общий журнал.
 *
 * Почему middleware, а не вызов в каждом обработчике. В модулях стенда от
 * десятков до сотни мутирующих маршрутов; поштучная разметка означала бы
 * столько же правок, которые разойдутся при первой доработке - новый маршрут
 * добавят, а строчку журналирования забудут. Здесь одна точка, покрывающая и
 * те маршруты, которых ещё нет.
 *
 * Побочная выгода, недостижимая поштучно: middleware видит код ответа, поэтому
 * в журнал попадают отказы (401/403) и сбои. Именно они нужны службе
 * безопасности по §5 ТЗ, и вызов внутри успешной ветки обработчика их не
 * увидит никогда.
 *
 * Про «не тормозит». Событие собирается в `res.on('finish')` - то есть уже
 * после того, как ответ ушёл клиенту. Задержки нет по построению, а не по
 * замеру. Дальше событие лишь кладётся в очередь клиента; отправляет её
 * отложенный таймер.
 *
 * Что попадает в событие, кроме «кто и когда»:
 *
 *   - **что отправили** - поля тела запроса (`express.json()` разобрал его до
 *     нас, поэтому это бесплатно). Помечаются `kind: 'submitted'`: это
 *     присланные значения, а не разница «было → стало»;
 *   - **над каким документом** - номер и название из ответа, перехваченного
 *     подменой `res.json`. Без этого в журнале стоял бы только идентификатор;
 *   - **что открыли** - при `trackReads` GET на конкретный объект пишется как
 *     просмотр: «открыл смету № 123». Это и есть «куда перешёл» в бизнес-
 *     смысле, и достаётся оно без правки интерфейса модуля.
 *
 * Чего по-прежнему нет: настоящей разницы «было → стало». Для неё нужно
 * прочитать объект **до** записи, а это работа в каждом обработчике.
 * Обработчики, где diff важен, размечаются поверх - `audit-client.record()`
 * вызывается напрямую, и middleware такое событие не дублирует.
 */

'use strict';

const audit = require('./audit-client');

const ACTION_BY_METHOD = {
  POST: 'CREATE',
  PUT: 'UPDATE',
  PATCH: 'UPDATE',
  DELETE: 'DELETE',
};

const DEFAULT_ACTION_BY_VERB = {
  approve: 'APPROVE',
  reject: 'REJECT',
  resolve: 'APPROVE',
  submit: 'STATUS_CHANGE',
  activate: 'STATUS_CHANGE',
  deactivate: 'STATUS_CHANGE',
  'send-for-approval': 'STATUS_CHANGE',
  'toggle-exclusion': 'STATUS_CHANGE',
  post: 'STATUS_CHANGE',
  send: 'STATUS_CHANGE',
  receive: 'STATUS_CHANGE',
  complete: 'STATUS_CHANGE',
  cancel: 'STATUS_CHANGE',
  close: 'STATUS_CHANGE',
  sign: 'STATUS_CHANGE',
  import: 'IMPORT',
  upload: 'IMPORT',
  export: 'EXPORT',
  print: 'PRINT',
  link: 'LINK',
  unlink: 'UNLINK',
  comment: 'COMMENT',
};

// Метка «этот адрес в журнал не идёт ни при каком ответе».
const SKIPPED = Object.freeze({ skipped: true });

function resultForStatus(status) {
  if (status < 400) return 'success';
  // 409 - тоже отказ, только по правилу учёта, а не по правам: «редактирование
  // разрешено только для черновиков», «номер занят». Для аудитора это тот же
  // вопрос «почему не дали».
  if (status === 401 || status === 403 || status === 409) return 'denied';
  return 'error';
}

/**
 * Причина отказа из ответа модуля.
 *
 * Брать её больше негде и больше нигде не надо: маршруты уже отвечают
 * пользователю по-русски и по делу - «Недостаточно прав — редактирование
 * справочников доступно только менеджеру или администратору», «У вас нет прав
 * на изменение цен в этом регионе». Журнал раньше эти слова выбрасывал и
 * оставлял одно «отказ».
 */
function reasonFromAnswer(answer) {
  if (!answer || typeof answer !== 'object') {
    return typeof answer === 'string' ? answer.trim().slice(0, 500) : '';
  }
  for (const key of ['error', 'detail', 'message', 'reason']) {
    const value = answer[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 500);
  }
  return '';
}

// ---------------------------------------------------------------- подробности

/**
 * Поля, которые в журнал не попадают никогда.
 *
 * Пароль или токен в журнале - это утечка с длинным сроком хранения: журнал
 * append-only, стереть запись нельзя. Проверка по подстроке, а не по точному
 * имени: встречаются и `password`, и `passwordConfirm`, и `newPassword`.
 */
const SECRET_FIELD_PARTS = ['password', 'passwd', 'secret', 'token', 'apikey', 'api_key', 'auth', 'pin', 'cvv', 'iban'];

/** Сколько полей тела запроса записываем. Остальное - счётчиком. */
const MAX_BODY_FIELDS = 40;
const MAX_BODY_VALUE = 400;

// Общие имена полей -> русские подписи. Модуль дополняет своим словарём:
// журнал смотрят глазами, и `validation_status` в нём читается плохо.
const COMMON_FIELD_LABELS = {
  name: 'название',
  title: 'заголовок',
  code: 'код',
  status: 'статус',
  comment: 'комментарий',
  amount: 'сумма',
  total: 'итого',
  price: 'цена',
  quantity: 'количество',
  currency: 'валюта',
  date: 'дата',
  reason: 'причина',
  type: 'тип',
  number: 'номер',
  email: 'e-mail',
  phone: 'телефон',
  role: 'роль',
  is_active: 'активен',
  description: 'описание',
  warehouse: 'склад',
  supplier: 'поставщик',
  contract: 'договор',
  project: 'проект',
};

function isSecretField(name) {
  const lower = String(name).toLowerCase();
  return SECRET_FIELD_PARTS.some((part) => lower.includes(part));
}

function shortValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  if (Array.isArray(value)) return `${value.length} поз.`;
  if (typeof value === 'object') return JSON.stringify(value).slice(0, MAX_BODY_VALUE);
  return String(value).slice(0, MAX_BODY_VALUE);
}

/**
 * Поля тела запроса как подробности события.
 *
 * Помечаются `kind: 'submitted'` - это присланные значения, а не разница «было
 * → стало»: состояния объекта до записи middleware не видит. Выдавать их за
 * diff нельзя, иначе журнал утверждал бы, что поле было пустым.
 */
function fieldsFromBody(body, labels) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const dictionary = { ...COMMON_FIELD_LABELS, ...(labels || {}) };
  const rows = [];
  let hidden = 0;

  for (const [field, value] of Object.entries(body)) {
    if (isSecretField(field)) continue;
    if (value === null || value === undefined || value === '') continue;
    if (rows.length >= MAX_BODY_FIELDS) {
      hidden += 1;
      continue;
    }
    rows.push({
      field,
      label: dictionary[field] || field,
      after: shortValue(value),
      kind: 'submitted',
    });
  }

  if (hidden) {
    rows.push({ field: '', label: `…и ещё ${hidden} полей`, after: 'не показаны', kind: 'submitted' });
  }
  return rows;
}

/** Номер и название объекта из ответа - чтобы в журнале стоял документ, а не id. */
const NUMBER_KEYS = ['number', 'document_number', 'documentNumber', 'doc_number', 'code', 'entity_number'];
const TITLE_KEYS = ['name', 'title', 'label', 'normalized_name', 'full_name'];
const ID_KEYS = ['id', 'uuid', 'entity_id', 'doc_id'];

function pick(payload, keys) {
  if (!payload || typeof payload !== 'object') return '';
  for (const key of keys) {
    const value = payload[key];
    if (value !== null && value !== undefined && value !== '') return String(value).slice(0, 200);
  }
  return '';
}

/**
 * Запомненные названия объектов: идентификатор -> название.
 *
 * Зачем. В журнале Смет колонка «Объект» показывала UUID проекта - «нормальное
 * название, а не айди» было первым, что про неё сказали. Название у модуля
 * есть, но приходит оно не тогда, когда нужно: при правке документа ответ
 * возвращает результат операции, а не карточку с именем.
 *
 * Откуда берём. Из любого ответа, который модуль и так отдаёт: открыл список
 * проектов - в нём имена всех, открыл карточку - имя одного. Кеш наполняется
 * собственным трафиком модуля и ничего не стоит: ни одного лишнего запроса к
 * базе, только разбор уже полученного ответа.
 *
 * Чего не делаем. Не ходим за именем сами. Журнал не имеет права добавлять
 * модулю запросов - это ровно то «торможение», которого просили избежать.
 * Имени нет - событие уходит с одним идентификатором, и это честно.
 */
const NAME_CACHE_LIMIT = 5000;
const nameCache = new Map();

function rememberName(id, name) {
  const key = String(id || '').trim();
  const value = String(name || '').trim();
  if (!key || !value || key === value) return;
  // Идентификаторы попадаются и числовые, и UUID - годятся оба. А вот имя
  // длиной с абзац это уже не имя, а текст документа.
  if (value.length > 200) return;
  if (nameCache.size >= NAME_CACHE_LIMIT) {
    // Вычищаем четверть самых старых: Map хранит порядок вставки.
    let drop = Math.floor(NAME_CACHE_LIMIT / 4);
    for (const existing of nameCache.keys()) {
      nameCache.delete(existing);
      if (--drop <= 0) break;
    }
  }
  nameCache.set(key, value);
}

function rememberedName(id) {
  return nameCache.get(String(id || '').trim()) || '';
}

/**
 * Проходит по ответу и запоминает пары «идентификатор - название».
 *
 * Глубина ограничена намеренно: ответы модулей бывают с вложенными позициями
 * на несколько экранов, и полный обход стоил бы заметного времени на каждом
 * запросе. Двух уровней хватает на список объектов и на карточку с вложенным
 * списком.
 */
function harvestNames(payload, depth = 0) {
  if (!payload || depth > 2) return;
  if (Array.isArray(payload)) {
    // Список целиком обходить незачем: страница списка и так отдаёт первые
    // десятки, а дальше идёт хвост, который в журнал в ближайшее время не
    // попадёт.
    for (const item of payload.slice(0, 200)) harvestNames(item, depth + 1);
    return;
  }
  if (typeof payload !== 'object') return;

  const id = pick(payload, ID_KEYS);
  const name = pick(payload, TITLE_KEYS) || pick(payload, NUMBER_KEYS);
  if (id && name) rememberName(id, name);

  for (const value of Object.values(payload)) {
    if (value && typeof value === 'object') harvestNames(value, depth + 1);
  }
}

function describeAnswer(payload) {
  // Ответ бывает обёрнут: {data: {...}} или {document: {...}}.
  let target = payload;
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    for (const wrapper of ['data', 'document', 'result', 'item', 'record']) {
      if (target[wrapper] && typeof target[wrapper] === 'object' && !Array.isArray(target[wrapper])) {
        target = target[wrapper];
        break;
      }
    }
  }
  return {
    entityNumber: pick(target, NUMBER_KEYS),
    entityTitle: pick(target, TITLE_KEYS),
    entityId: pick(target, ID_KEYS),
  };
}

/**
 * @param {object} options
 * @param {Array} [options.routes] явная таблица шаблонов, проверяется первой
 * @param {Record<string,string>} [options.entityByCollection] коллекция в адресе -> тип объекта
 * @param {Record<string,string>} [options.actionByVerb] завершающий глагол -> тип действия
 * @param {string[]} [options.skipCollections] что в журнал не идёт
 * @param {string[]} [options.stripPrefixes] префиксы адреса, которые надо срезать
 * @param {string[]} [options.groupingSegments] сегменты-группировщики, а не коллекции
 * @param {(req: any) => object} [options.actorFrom] как достать личность из запроса
 * @param {Record<string,string>} [options.fieldLabels] имя поля -> русская подпись
 *
 * Два способа опознать маршрут, и оба нужны:
 *
 * - `entityByCollection` - для регулярного REST (`/api/v1/receipts/:id/post`).
 *   Коротко и покрывает будущие маршруты над той же коллекцией само.
 * - `routes` - для нерегулярного API, где коллекция не первый сегмент
 *   (`/api/estimates/resource/:id`) или где адрес вообще не про коллекцию
 *   (`/api/estimates/approve`). Тут карта по коллекциям молча врала бы,
 *   поэтому нужен явный шаблон.
 *
 * Каждый элемент `routes`: `{ methods?, pattern, entityType, action?, idGroup? }`.
 * `action` можно не указывать - тогда он выводится из метода и глагола.
 * `idGroup` - номер группы в регулярке, откуда взять идентификатор объекта.
 * Первое совпадение выигрывает.
 */
function createJournalMiddleware(options) {
  const routes = Array.isArray(options.routes) ? options.routes : [];
  const entityByCollection = options.entityByCollection || {};
  const actionByVerb = { ...DEFAULT_ACTION_BY_VERB, ...(options.actionByVerb || {}) };
  const skip = new Set(options.skipCollections || []);
  const stripPrefixes = options.stripPrefixes || ['/api/v1/', '/api/'];
  const grouping = new Set(options.groupingSegments || []);
  const actorFrom = options.actorFrom || defaultActor;
  // Русские подписи для полей тела запроса: журнал читают глазами, и
  // `validation_status` в нём выглядит плохо.
  const fieldLabels = options.fieldLabels || {};
  // Писать ли открытие объектов (GET с идентификатором) как просмотр.
  //
  // По умолчанию да: без этого раздел «Переходы по модулю» остаётся пустым, а
  // на вопрос «что человек смотрел перед тем, как изменить сумму» ответить
  // нечем. Выключается переменной AUDIT_LOG_READS=false, если поток окажется
  // слишком плотным.
  const trackReads = options.trackReads !== false;

  function fromRoutes(method, path) {
    for (const route of routes) {
      const methods = route.methods
        ? (Array.isArray(route.methods) ? route.methods : [route.methods]).map((m) => m.toUpperCase())
        : null;
      if (methods && !methods.includes(method)) continue;

      const match = route.pattern.exec(path);
      if (!match) continue;

      // skip: true - «этот адрес в журнал не идёт». Нужен для ручек, которые
      // отвечают на POST, но ничего не сохраняют: расчёты, предпросмотры,
      // проверки. Без явного исключения журнал записывал их как создание
      // объекта - то есть утверждал неправду о действии, которого не было.
      if (route.skip) return { skip: true };

      let action = route.action;
      if (!action) {
        const tail = path.split('?')[0].split('/').filter(Boolean).pop() || '';
        action = actionByVerb[tail.toLowerCase()] || ACTION_BY_METHOD[method];
      }
      return {
        entityType: route.entityType,
        action,
        entityId: route.idGroup ? String(match[route.idGroup] || '') : '',
        // Человеческое название действия. Без него в ячейке «что произошло»
        // стоял адрес обработчика - «PUT /api/v1/unification-fields/job», - и
        // на вопрос «что произошло» журнал отвечал маршрутом.
        title: typeof route.title === 'function' ? route.title(match) : route.title || '',
      };
    }
    return null;
  }

  function readsEnabled() {
    if (!trackReads) return false;
    return String(process.env.AUDIT_LOG_READS ?? 'true').trim().toLowerCase() !== 'false';
  }

  /**
   * Открытие объекта: GET на адрес с идентификатором.
   *
   * Списки и справочники не пишутся - их дёргает каждая страница, и поток
   * получился бы кратно больше потока настоящих действий. Пишется только
   * обращение к конкретному объекту: это и есть «открыл документ».
   */
  function describeRead(rawPath) {
    if (!readsEnabled()) return null;

    const clean = String(rawPath || '').split('?')[0];
    const explicit = fromRoutes('GET', clean);
    if (explicit && explicit.skip) return null;
    if (explicit && explicit.entityId) {
      return { entityType: explicit.entityType, action: 'NAVIGATE', entityId: explicit.entityId };
    }

    let trimmed = clean;
    for (const prefix of stripPrefixes) {
      if (trimmed.startsWith(prefix)) {
        trimmed = trimmed.slice(prefix.length);
        break;
      }
    }
    let parts = trimmed.split('/').filter(Boolean);
    while (parts.length > 1 && grouping.has(parts[0])) parts = parts.slice(1);
    // Ровно /коллекция/идентификатор. Список (один сегмент) не пишем - его
    // дёргает каждая страница. Подресурс (три сегмента) тоже: это часть уже
    // открытого объекта, а не отдельный переход.
    if (parts.length !== 2) return null;
    if (skip.has(parts[0])) return null;

    const entityType = entityByCollection[parts[0]];
    if (!entityType) return null;

    // Второй сегмент - глагол, а не идентификатор: это не открытие объекта.
    if (actionByVerb[parts[1].toLowerCase()]) return null;

    // NAVIGATE, а не VIEW. VIEW в словаре §3.2 помечен чувствительным и по
    // умолчанию не пишется (§3.4 - просмотр финансовых условий), а открытие
    // документа - это переход по модулю, и он нужен в разделе «Переходы».
    return { entityType, action: 'NAVIGATE', entityId: parts[1] };
  }

  function describe(method, rawPath) {
    if (method === 'GET') return describeRead(rawPath);
    if (!ACTION_BY_METHOD[method]) return null;

    const clean = String(rawPath || '').split('?')[0];
    const explicit = fromRoutes(method, clean);
    // SKIPPED, а не null: «не размечено» и «исключено намеренно» - разные
    // вещи, и различать их обязательно. Отказы пишутся даже на неразмеченных
    // адресах, а на исключённых не должны: там либо расчёт, который ничего не
    // сохраняет, либо сама ручка приёма событий журнала - просроченный пропуск
    // в открытой вкладке давал бы отказ на каждую отправку.
    if (explicit) return explicit.skip ? SKIPPED : explicit;

    let trimmed = clean;
    for (const prefix of stripPrefixes) {
      if (trimmed.startsWith(prefix)) {
        trimmed = trimmed.slice(prefix.length);
        break;
      }
    }

    let parts = trimmed.split('/').filter(Boolean);
    while (parts.length > 1 && grouping.has(parts[0])) parts = parts.slice(1);
    if (!parts.length) return null;

    const collection = parts[0];
    if (skip.has(collection)) return null;

    const entityType = entityByCollection[collection];
    if (!entityType) return null;

    let action = ACTION_BY_METHOD[method];
    let entityId = '';

    if (parts.length >= 2) {
      const tail = parts[parts.length - 1].toLowerCase();
      const verb = actionByVerb[tail];
      if (verb && parts.length >= 3) {
        action = verb;
        entityId = parts[1];
      } else if (verb) {
        action = verb;
      } else {
        entityId = parts[1];
      }
    }

    return { entityType, action, entityId };
  }

  function middleware(req, res, next) {
    // Один обработчик на ответ, сколько бы раз middleware ни был подключён.
    //
    // Express прогоняет запрос через все совпавшие монтирования: адрес
    // /api/v1/erp/sync-all подходит и под app.use('/api/v1'), и под
    // app.use('/api/v1/erp'), поэтому без этой отметки одно действие уезжало в
    // журнал дважды. Проверять монтирования в каждом модуле хрупко - защита
    // должна жить здесь.
    if (res.__auditJournalAttached) return next();
    res.__auditJournalAttached = true;

    let described = null;
    try {
      described = describe(req.method, req.originalUrl || req.url);
    } catch {
      described = null;
    }

    // Раньше здесь был безусловный выход, и вопрос «почему человеку отказали»
    // оставался без ответа для всего, чего нет в карте маршрутов: списков,
    // справочников, отчётов. А отказ - как раз то событие, которое пропускать
    // нельзя: разметку можно дополнить потом, отказ не повторится. Поэтому
    // неразмеченный маршрут пропускаем только до кода ответа, а дальше решаем
    // по нему (см. ветку с PERMISSION_DENIED в обработчике finish).
    //
    // Исключённый явно (skip: true) - другое дело: он не идёт в журнал ни при
    // каком ответе, и слушателя ему заводить незачем.
    if (described === SKIPPED) return next();

    // Ответ перехватывается подменой res.json, а не буферизацией потока: из
    // ответа нужны только номер и название созданного объекта, а буферизация
    // стоила бы памяти и задержки на каждом запросе. Маршруты модулей стенда
    // отвечают через res.json, поэтому подмены достаточно.
    let answer = null;
    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      answer = payload;
      // Имена запоминаются из **любого** ответа, даже если само событие в
      // журнал не идёт: открытый список проектов наполняет кеш именами, и
      // следующая правка любого из них уйдёт в журнал уже с названием, а не с
      // одним идентификатором.
      try {
        harvestNames(payload);
      } catch {
        /* разбор имён не имеет права ломать ответ */
      }
      return originalJson(payload);
    };

    // finish, а не await: обработчик и ответ клиенту нас не ждут вовсе.
    res.on('finish', () => {
      try {
        const outcome = resultForStatus(res.statusCode);
        if (described === SKIPPED) return;
        // Маршрут не размечен: пишем только отказы, и объектом будет сам
        // модуль - что именно пытались сделать, отсюда не видно, адрес
        // остаётся в комментарии.
        if (!described && outcome !== 'denied') return;
        // Ошибки валидации в журнал не идут: их поток кратно больше потока
        // настоящих действий. Отказы в доступе идут - они и нужны службе
        // безопасности. Серверные сбои идут: по ним видно, что действие
        // пытались совершить, а система не смогла.
        if (outcome === 'error' && res.statusCode < 500) return;

        // Подробности: что отправили (тело запроса) и над каким документом
        // (номер из ответа). Тело уже разобрано express.json() до нас, так что
        // читать поток не нужно - это бесплатно.
        const isRead = req.method === 'GET';
        const submitted = isRead ? [] : fieldsFromBody(req.body, fieldLabels);
        const described2 = outcome === 'success' ? describeAnswer(answer) : {};
        // Название объекта: из ответа, а если там его нет - из запомненных.
        // Именно этот случай и давал «непонятные проекты»: правка возвращает
        // результат операции, а не карточку с именем.
        const knownId = described.entityId || described2.entityId || '';
        const title = described2.entityTitle || rememberedName(knownId);
        const why = outcome === 'success' ? '' : reasonFromAnswer(answer);

        const target = described || {
          entityType: `${audit.moduleCode ? audit.moduleCode() : ''}_session`,
          action: 'PERMISSION_DENIED',
          entityId: '',
        };

        audit.record({
          entityType: target.entityType,
          actionType: target.action,
          entityId: target.entityId || described2.entityId || '',
          entityNumber: described2.entityNumber || '',
          entityTitle: title,
          changes: submitted,
          result: outcome,
          resultReason: why,
          source: 'api',
          // Человеческое название, если маршрут его дал. Адрес обработчика -
          // запасной вариант: он нужен при разборе инцидента, но это не ответ
          // на «что произошло», и интерфейс журнала показывает его подписью.
          comment: described.title || `${req.method} ${(req.originalUrl || req.url || '').split('?')[0]}`,
          ipAddress: req.ip || req.socket?.remoteAddress || '',
          userAgent: req.headers?.['user-agent'] || '',
          ...actorFrom(req),
        });
      } catch {
        /* журнал не имеет права ломать ответ */
      }
    });

    return next();
  }

  middleware.describe = describe;
  return middleware;
}

/** Личность по умолчанию: req.user, как его кладут модули стенда. */
function defaultActor(req) {
  const user = req.user || {};
  return {
    actorId: String(user.id || user.sub || user.email || ''),
    actorEmail: String(user.email || ''),
    actorName: String(user.name || user.full_name || user.email || ''),
    actorRole: String(user.role || ''),
    actorRegion: String(user.region || user.regionNames || ''),
    organizationId: String(user.organizationId || user.organization_id || ''),
  };
}

module.exports = { createJournalMiddleware, resultForStatus, reasonFromAnswer, defaultActor, DEFAULT_ACTION_BY_VERB };
