/**
 * Клиент журнала действий для модулей на Node (Express, Next.js).
 *
 * Тот же контракт, что у Python-версии `audit_client.py`, и те же три
 * обещания:
 *
 * 1. **Основная операция не ждёт журнал.** `record()` синхронно кладёт событие
 *    в очередь и возвращается. Ничего не await-ит и не возвращает промис,
 *    который кто-то забудет дождаться. Отправка - отложенным таймером.
 *
 * 2. **Событие не теряется при недоступности журнала.** Не ушедшее уезжает в
 *    файл и повторяется. `eventId` генерируется до первой попытки, поэтому
 *    повтор не создаёт дубль - журнал отбрасывает его по ключу.
 *
 * 3. **Ошибка журнала не ломает модуль.** Всё внутри обёрнуто; наружу не
 *    выходит ни исключение, ни отклонённый промис.
 *
 * Про «не тормозит» подробнее. Таймер отправки создаётся через `setTimeout` и
 * помечается `unref()`: висящий таймер не держит процесс Node живым, поэтому
 * подключение журнала не мешает ни перезапуску сервера, ни завершению
 * серверного действия Next.js.
 *
 * Настройка через окружение модуля:
 *
 *     AUDIT_URL           http://127.0.0.1:9010
 *     AUDIT_MODULE        crm | mdm | estimates
 *     AUDIT_INGEST_KEY    <серверный ключ приёма>
 *     AUDIT_ENABLED       true
 *     AUDIT_BUFFER_PATH   logs/audit-outbox.jsonl
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Отправляем пачками: на 50 событий один запрос вместо пятидесяти.
const BATCH_SIZE = 50;

// Задержка перед отправкой. Достаточно мала, чтобы событие ушло практически
// сразу, и достаточно велика, чтобы серия действий склеилась в одну пачку.
const FLUSH_DELAY_MS = 250;

// Пауза при недоступном журнале, растёт до минуты - чтобы не долбить лежащий
// сервис на каждом событии.
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 60000;

// Предел очереди в памяти. Переполнение уходит сразу в файл, а не растёт в
// процессе модуля.
const QUEUE_LIMIT = 2000;

// Предел файла-буфера: журнал недоступен неделю - файл не должен съесть диск.
const BUFFER_LIMIT = 20000;

const queue = [];
let timer = null;
let sending = false;
let backoff = RETRY_MIN_MS;

function enabled() {
  const raw = String(process.env.AUDIT_ENABLED ?? 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function url() {
  return String(process.env.AUDIT_URL || 'http://127.0.0.1:9010').trim().replace(/\/+$/, '');
}

function moduleCode() {
  return String(process.env.AUDIT_MODULE || '').trim();
}

function ingestKey() {
  return String(process.env.AUDIT_INGEST_KEY || '').trim();
}

function bufferPath() {
  const configured = String(process.env.AUDIT_BUFFER_PATH || '').trim();
  if (configured) return configured;
  return path.join(process.cwd(), 'logs', 'audit-outbox.jsonl');
}

function warn(message, error) {
  // Через console, а не через логгер модуля: клиент не должен зависеть от того,
  // как именно модуль настроил логирование.
  console.warn(`[audit] ${message}${error ? `: ${error.message || error}` : ''}`);
}

// ---------------------------------------------------------------- файл-буфер

function appendBuffer(rows) {
  if (!rows.length) return;
  try {
    const file = bufferPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    trimBuffer(file);
  } catch (error) {
    warn('буфер не записан', error);
  }
}

function trimBuffer(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= BUFFER_LIMIT) return;
    const dropped = lines.length - BUFFER_LIMIT;
    warn(`буфер переполнен: отброшено ${dropped} самых старых событий, журнал недоступен слишком долго`);
    fs.writeFileSync(file, lines.slice(-BUFFER_LIMIT).join('\n') + '\n', 'utf8');
  } catch {
    /* переполненный буфер - не повод падать */
  }
}

function drainBuffer() {
  try {
    const file = bufferPath();
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    fs.unlinkSync(file);
    const rows = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') rows.push(parsed);
      } catch {
        /* битую строку молча пропускаем */
      }
    }
    return rows;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- отправка

function schedule(delay = FLUSH_DELAY_MS) {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, delay);
  // unref: таймер не держит процесс живым. Без этого подключение журнала
  // задерживало бы завершение процесса Node на время задержки отправки.
  if (typeof timer.unref === 'function') timer.unref();
}

async function post(rows) {
  const key = ingestKey();
  if (!key) {
    warn('AUDIT_INGEST_KEY не задан: события отправить нечем');
    return false;
  }

  let response;
  try {
    response = await fetch(`${url()}/api/v1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Audit-Ingest-Key': key,
      },
      body: JSON.stringify({ events: rows }),
      // Ответ нам нужен только чтобы понять, повторять или нет.
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    warn('журнал недоступен', error);
    return false;
  }

  if (response.ok) {
    try {
      const answer = await response.json();
      if (Array.isArray(answer?.unregistered) && answer.unregistered.length) {
        warn(`журнал не знает: ${answer.unregistered.slice(0, 10).join(', ')} - дозаполните справочники`);
      }
    } catch {
      /* тело ответа не обязательно разбирать */
    }
    return true;
  }

  // 4xx - наша вина: неверный ключ или формат. Повторять бессмысленно, событие
  // всё равно не примут, поэтому не копим его вечно.
  if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
    const detail = await response.text().catch(() => '');
    warn(`журнал отклонил события: HTTP ${response.status} ${detail.slice(0, 200)}`);
    return true;
  }

  warn(`журнал ответил HTTP ${response.status}`);
  return false;
}

async function flush() {
  if (sending) return;
  sending = true;
  try {
    const pending = drainBuffer();
    const batch = pending.concat(queue.splice(0, QUEUE_LIMIT)).slice(0, BATCH_SIZE * 4);
    const overflow = pending.concat(queue).slice(BATCH_SIZE * 4);
    if (overflow.length) appendBuffer(overflow);
    if (!batch.length) return;

    const ok = await post(batch);
    if (ok) {
      backoff = RETRY_MIN_MS;
      if (queue.length) schedule();
      return;
    }

    appendBuffer(batch);
    const wait = backoff;
    backoff = Math.min(RETRY_MAX_MS, backoff * 2);
    schedule(wait);
  } catch (error) {
    warn('отправщик споткнулся', error);
  } finally {
    sending = false;
  }
}

// ---------------------------------------------------------------- публичное

function nowIso() {
  return new Date().toISOString();
}

/**
 * Отправляет событие в журнал. Синхронна, ничего не ждёт, не бросает.
 * Возвращает eventId или null, если журнал выключен.
 */
function record(event) {
  if (!enabled()) return null;

  try {
    const code = String(event.module || moduleCode() || '').trim();
    if (!code) {
      warn(`AUDIT_MODULE не задан: событие ${event.entityType}/${event.actionType} не отправлено`);
      return null;
    }

    const eventId = event.eventId || crypto.randomUUID();
    queue.push({
      event_id: eventId,
      occurred_at: event.occurredAt || nowIso(),
      tz_offset_minutes: Number(event.tzOffsetMinutes || 0),
      module: code,
      entity_type: String(event.entityType || ''),
      entity_id: String(event.entityId ?? ''),
      entity_number: String(event.entityNumber || ''),
      entity_title: String(event.entityTitle || '').slice(0, 300),
      action_type: String(event.actionType || 'UPDATE').toUpperCase(),
      changes: Array.isArray(event.changes) ? event.changes : [],
      comment: String(event.comment || '').slice(0, 2000),
      source: String(event.source || 'ui'),
      related_entities: Array.isArray(event.relatedEntities) ? event.relatedEntities : [],
      result: String(event.result || 'success'),
      // Почему отказано или почему не получилось - текстом, как модуль ответил
      // пользователю. У успеха пусто: непустая причина при успехе означала бы,
      // что источник считает успех отказом.
      result_reason: String(event.resultReason || '').slice(0, 500),
      // Личность едет в теле, потому что модуль отправляет события серверным
      // ключом - пропуска пользователя у фонового отправщика нет. Ключ обязан
      // жить только между серверами.
      actor_id: String(event.actorId || event.actorEmail || ''),
      actor_email: String(event.actorEmail || ''),
      actor_name: String(event.actorName || ''),
      actor_role: String(event.actorRole || ''),
      // Регион сотрудника: заполняют модули, где сотрудники закреплены за
      // регионами (Сметы/УСП). У остальных остаётся пустым.
      actor_region: String(event.actorRegion || ''),
      organization_id: String(event.organizationId || ''),
      session_id: String(event.sessionId || ''),
      ip_address: String(event.ipAddress || ''),
      user_agent: String(event.userAgent || '').slice(0, 300),
    });

    if (queue.length > QUEUE_LIMIT) {
      // Очередь переполнена - журнал давно не отвечает. Сбрасываем в файл,
      // чтобы не потерять и не расти в памяти.
      appendBuffer(queue.splice(0, queue.length - QUEUE_LIMIT));
    }

    schedule();
    return eventId;
  } catch (error) {
    warn('событие не поставлено в очередь', error);
    return null;
  }
}

/** Ждёт отправки очереди. Нужно тестам и остановке процесса. */
async function flushNow(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!queue.length && !sending) return true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** Список изменённых полей из двух снимков объекта. */
function describeChanges(before, after, labels) {
  const changes = [];
  for (const [field, label] of Object.entries(labels || {})) {
    const was = readable(before?.[field]);
    const now = readable(after?.[field]);
    if (was !== now) changes.push({ field, label: label || field, before: was, after: now });
  }
  return changes;
}

function readable(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 2000);
  return String(value).trim().slice(0, 2000);
}

// ------------------------------------------------- входы и отказы

/**
 * Отсечка повторов для входов.
 *
 * Пропуск проверяется на **каждом** запросе, и без этой отсечки раздел «Входы
 * и отказы» состоял бы из одной строки «вошёл», повторённой сотни раз за
 * сессию. Ключ - модуль + личность + причина: повторный отказ с другой
 * причиной это новое событие и записать его надо.
 *
 * Полчаса, а не минута. С минутным окном одна рабочая сессия давала «вошёл»
 * каждую минуту: у сотрудника за час работы 60 одинаковых строк, и раздел в
 * них утонул. Выхода из модуля не существует - вкладку просто закрывают, -
 * поэтому «одна сессия» приближается окном тишины: полчаса без запросов
 * считаем новым входом. Настраивается AUDIT_SESSION_DEDUP_MINUTES.
 */
function sessionTtlMs() {
  const raw = Number(process.env.AUDIT_SESSION_DEDUP_MINUTES);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : 30;
  return minutes * 60_000;
}
const SESSION_LIMIT = 512;
const seenSessions = new Map();

function shouldRecordSession(key) {
  const now = Date.now();
  const last = seenSessions.get(key);
  if (last !== undefined && now - last < sessionTtlMs()) return false;
  if (seenSessions.size >= SESSION_LIMIT) seenSessions.clear();
  seenSessions.set(key, now);
  return true;
}

/**
 * Вход, выход или отказ в доступе - в раздел «Входы и отказы».
 *
 * @param {'LOGIN'|'LOGOUT'|'ACCESS_DENIED'} action
 * @param {object} event { entityType, actorId, actorEmail, actorName, actorRole,
 *                         actorRegion, organizationId, sessionId, reason,
 *                         ipAddress, userAgent }
 */
function recordSession(action, event = {}) {
  try {
    const who = String(event.actorId || event.actorEmail || event.sessionId || 'anon');
    const reason = String(event.reason || '');
    if (!shouldRecordSession(`${action}:${who}:${reason}`)) return null;

    return record({
      entityType: event.entityType || `${moduleCode()}_session`,
      actionType: action,
      entityId: event.sessionId || '',
      // Причина - в своём поле, а не в названии объекта. Раньше она лежала в
      // entityTitle, и для отказа на входе это работало: объекта у входа нет.
      // Но то же поле у отказа на документе занято названием документа, и
      // затирать его причиной значило бы потерять, чего именно не дали
      // сделать. Строку журнала собирает describe_event - он читает и старые
      // записи из entityTitle, поэтому история остаётся читаемой.
      resultReason: reason.slice(0, 500),
      result: action === 'ACCESS_DENIED' ? 'denied' : 'success',
      source: 'ui',
      actorId: event.actorId || '',
      actorEmail: event.actorEmail || '',
      actorName: event.actorName || event.actorEmail || '',
      actorRole: event.actorRole || '',
      // Регион обязателен и здесь: вход - это тоже событие в журнале, и в
      // колонке «Регион» он не должен быть пустым только потому, что это вход,
      // а не правка документа. Забыть его тут - ровно то, что я и сделал в
      // первой версии.
      actorRegion: event.actorRegion || '',
      organizationId: event.organizationId || '',
      sessionId: event.sessionId || '',
      ipAddress: event.ipAddress || '',
      userAgent: event.userAgent || '',
    });
  } catch (error) {
    warn('событие входа не записано', error);
    return null;
  }
}

module.exports = { record, recordSession, flushNow, describeChanges, readable, nowIso, moduleCode };
