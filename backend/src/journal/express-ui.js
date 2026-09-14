/**
 * Приём нажатий из браузера и отправка их в общий журнал (модуль на 9010).
 *
 * Пара к sdk/journal-ui.js: тот собирает нажатия на странице, этот их
 * принимает. Разделение обязательное - браузер не имеет права писать в журнал
 * напрямую: событию нужен доверенный ключ модуля и, главное, личность из
 * пропуска, а не из тела запроса. Иначе любой мог бы прислать «Иванов нажал
 * Удалить».
 *
 * Ставится после проверки пропуска, чтобы в req.user уже лежал сотрудник:
 *
 *   const { createUiRoute } = require('./journal/express-ui');
 *   app.post('/api/journal/ui', authMiddleware, createUiRoute());
 *
 * Отвечает 204 сразу: страница не ждёт журнала. Событие лишь ставится в
 * очередь клиента, отправляет её фоновый таймер.
 */

'use strict';

const audit = require('./audit-client');
const { defaultActor } = require('./express-journal');

// Сколько нажатий принимаем за один запрос. Клиенту не доверяем: он сам
// ограничивает пачку сороковкой, но проверка на стороне сервера обязана быть
// своя - журнал неизменяемый, и мусор из него потом не убрать.
const MAX_EVENTS = 60;

// Разрешённые действия. Список закрытый: браузер присылает то, что видел
// пользователь, но какими действиями это называется в журнале, решает сервер.
const ALLOWED_ACTIONS = new Set(['UI_CLICK', 'UI_CLOSE']);

// Параметры адреса, которые в журнал попадать не должны никогда.
//
// Браузерный скрипт вычищает их сам, но проверка на приёме обязана быть своя:
// журнал append-only, и попавший в него действующий пропуск оттуда уже не
// убрать, а по такой записи можно войти в модуль.
const SECRET_PARAMS = /([?&])(token|access_token|refresh_token|key|apikey|api_key|secret|password|code)=[^&#]*/gi;

function safePath(raw, limit) {
  return text(String(raw || '').replace(SECRET_PARAMS, '$1$2=(скрыт)'), limit);
}

function text(value, limit) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/**
 * Время нажатия от браузера, если оно правдоподобно.
 *
 * Проверка нужна: время приходит с клиента, а часы на машине пользователя
 * могут быть сбиты или подменены. Событие «за прошлый год» ушло бы в партицию,
 * которой нет, и вставка отклонилась бы; событие «на месяц вперёд» испортило бы
 * хронологию. Допускаем сутки назад (страница могла провисеть открытой) и пять
 * минут вперёд на расхождение часов.
 */
function moment(raw) {
  const at = Date.parse(String(raw || ''));
  if (!Number.isFinite(at)) return new Date().toISOString();
  const now = Date.now();
  if (at < now - 24 * 60 * 60 * 1000 || at > now + 5 * 60 * 1000) {
    return new Date().toISOString();
  }
  return new Date(at).toISOString();
}

/**
 * @param {object} [options]
 * @param {(req: any) => object} [options.actorFrom] как достать личность из запроса
 * @param {string} [options.entityType] тип объекта; по умолчанию <модуль>_control
 */
function createUiRoute(options = {}) {
  const actorFrom = options.actorFrom || defaultActor;
  const entityType = options.entityType || `${audit.moduleCode()}_control`;

  return function uiRoute(req, res) {
    // Ответ раньше журнала: страница не должна ждать ни базы, ни сети.
    res.status(204).end();

    try {
      const body = req.body || {};
      const events = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS) : [];
      if (!events.length) return;

      const actor = actorFrom(req);
      const ipAddress = String(req.ip || (req.socket && req.socket.remoteAddress) || '');
      const userAgent = String((req.headers && req.headers['user-agent']) || '');

      for (const item of events) {
        const action = text(item && item.action, 40).toUpperCase() || 'UI_CLICK';
        if (!ALLOWED_ACTIONS.has(action)) continue;

        const label = text(item && item.label, 200);
        if (!label) continue; // «нажал» без указания, на что, - бесполезная строка

        // Комментарий отвечает на «где нажал»: страница, её заголовок и раздел
        // разметки. Без него в журнале осталось бы «нажал Удалить» - а удалить
        // можно на десяти страницах.
        const where = [
          text(item && item.pageTitle, 200),
          safePath(item && item.path, 300),
          text(item && item.place, 160),
        ].filter(Boolean);

        audit.record({
          entityType,
          actionType: action,
          // Подпись элемента - в название объекта: строку журнала собирает
          // describe_event, и для UI_CLICK он ставит название в кавычки -
          // «нажал «Подписать договор»».
          entityTitle: label,
          comment: [text(item && item.kind, 40), where.join(' | ')].filter(Boolean).join(': '),
          result: 'success',
          source: 'ui',
          occurredAt: moment(item && item.at),
          tzOffsetMinutes: Number(item && item.tzOffsetMinutes) || 0,
          ipAddress,
          userAgent,
          ...actor,
        });
      }
    } catch (error) {
      // Ответ уже ушёл; жаловаться некому и незачем.
    }
  };
}

module.exports = { createUiRoute, MAX_EVENTS, ALLOWED_ACTIONS };
