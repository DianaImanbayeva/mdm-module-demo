/**
 * Нажатия в интерфейсе - в общий журнал действий.
 *
 * Зачем нужен браузерный скрипт, если есть журналирование на сервере. Затем,
 * что серверу видны только запросы. «Открыл карточку договора» он покажет, а
 * «нажал Подписать, потом переключился на закладку Условия, потом нажал
 * Отмена» - нет: часть нажатий вообще не доходит до сервера, а те, что
 * доходят, приходят обезличенным POST по адресу, из которого не видно, на что
 * человек нажал. На вопрос «куда он нажал» отвечает только браузер.
 *
 * Что пишется: подпись элемента, на который нажали, и страница, где это
 * произошло. Что не пишется: содержимое полей, буфер обмена, движения мыши,
 * нажатия по неинтерактивным местам. Журнал append-only и живёт полгода -
 * лишнее в него попадать не должно.
 *
 * Про «не тормозит». Слушатель один, на document, `passive` и в фазе
 * всплытия: он не участвует в обработке нажатия и не может её задержать.
 * События копятся в массиве и уходят пачкой раз в несколько секунд, а при
 * уходе со страницы - keepalive-запросом, который браузер доводит до конца сам
 * и который перехода не держит.
 *
 * Подключение (одна строка в index.html или в layout):
 *   <script src="/journal-ui.js" data-endpoint="/api/journal/ui" defer></script>
 *
 * data-endpoint     куда отправлять; по умолчанию /api/journal/ui
 * data-flush-ms     период отправки, по умолчанию 4000
 * data-max-batch    сколько событий за отправку, по умолчанию 40
 * data-token-key      ключ пропуска в хранилище браузера (например token);
 *                     если не задан, берётся ?token= из адреса страницы
 * data-token-storage  local (по умолчанию) или session - какое хранилище
 * data-token-mode     header (по умолчанию, Authorization: Bearer) или query
 *                     (?token=... - так пропуск принимают Закупки)
 *
 * В data-endpoint можно подставить {host} и {origin}: у Смет клиент и сервер
 * живут на разных портах, а имя хоста у стенда меняется, и прописать адрес
 * целиком нельзя.
 *
 * Модули с пропуском в cookie (Склад, CRM) настройки пропуска не требуют
 * вовсе: запрос идёт с credentials: same-origin, и cookie уходит сама.
 *
 * Тонкое место, из-за которого пропуск читается перед каждой отправкой, а не
 * один раз при загрузке: у Смет и MDM пропуск обновляется по refresh_token, и
 * запомненный при загрузке через час оказался бы просроченным - последние
 * нажатия сессии потерялись бы молча.
 */

(function () {
  'use strict';

  if (typeof window === 'undefined' || window.__journalUiStarted) return;
  window.__journalUiStarted = true;

  var script = document.currentScript || (function () {
    var all = document.getElementsByTagName('script');
    for (var i = all.length - 1; i >= 0; i -= 1) {
      if ((all[i].src || '').indexOf('journal-ui') !== -1) return all[i];
    }
    return null;
  })();

  function setting(name, fallback) {
    var value = script && script.getAttribute('data-' + name);
    return value === null || value === undefined || value === '' ? fallback : value;
  }

  // {host} и {origin} подставляются здесь: адрес стенда меняется, а у Смет
  // клиент отдаётся с одного порта, а API слушает на другом.
  var ENDPOINT = String(setting('endpoint', '/api/journal/ui'))
    .replace('{host}', location.hostname)
    .replace('{origin}', location.origin);
  var FLUSH_MS = Math.max(1000, Number(setting('flush-ms', 4000)) || 4000);
  var MAX_BATCH = Math.max(1, Number(setting('max-batch', 40)) || 40);
  var TOKEN_KEY = setting('token-key', '');
  var TOKEN_MODE = String(setting('token-mode', 'header')).toLowerCase();
  var TOKEN_STORAGE = String(setting('token-storage', 'local')).toLowerCase();

  /**
   * Пропуск модуля: из хранилища браузера по ключу или из адреса страницы.
   *
   * Хранилище указывается явно, а не угадывается: MDM держит пропуск в
   * sessionStorage и вычищает ?token= из адреса сразу после входа, поэтому
   * искать его в localStorage или в адресе там бессмысленно - нажатия ушли бы
   * без пропуска и остались без автора.
   */
  function passToken() {
    try {
      if (TOKEN_KEY) {
        var box = TOKEN_STORAGE === 'session' ? window.sessionStorage : window.localStorage;
        var stored = box && box.getItem(TOKEN_KEY);
        if (stored) return String(stored);
      }
      var fromUrl = new URLSearchParams(location.search).get('token');
      return fromUrl ? String(fromUrl) : '';
    } catch (error) {
      // Хранилище может быть закрыто настройками браузера.
      return '';
    }
  }

  // Предел на минуту. Защита не от пользователя, а от интерфейса: залипшая
  // кнопка или обработчик, дёргающий click программно, иначе за час записал бы
  // в неизменяемый журнал десятки тысяч строк.
  var MAX_PER_MINUTE = 120;

  // Одно и то же нажатие дважды - это дребезг или двойной клик, а не два
  // действия. Отсекаем по подписи и странице.
  var REPEAT_MS = 1200;

  // Элементы, нажатие на которые считается действием. Клик по обычному тексту
  // или пустому месту действием не является, и писать его незачем.
  var CONTROLS = [
    'button',
    'a[href]',
    'summary',
    'input[type="submit"]',
    'input[type="button"]',
    'input[type="checkbox"]',
    'input[type="radio"]',
    '[role="button"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="switch"]',
    '[data-journal-label]',
  ].join(',');

  var queue = [];
  var recent = Object.create(null);
  var minuteStarted = Date.now();
  var minuteCount = 0;
  var timer = null;

  // Параметры адреса, которые в журнал попадать не должны никогда.
  //
  // Пропуск у Смет, MDM и Закупок ходит в адресе (?token=...), а адрес страницы
  // мы записываем как ответ на «где нажал». Без вычистки действующий пропуск
  // лёг бы в неизменяемую запись со сроком хранения полгода - по такой записи
  // можно войти в модуль. Ровно от этого в Складе когда-то ушли от ?token= в
  // пользу заголовка.
  var SECRET_PARAMS = ['token', 'access_token', 'refresh_token', 'key', 'apikey', 'api_key', 'secret', 'password', 'code'];

  /** Адрес страницы без пропусков и прочих секретов в параметрах. */
  function safePath() {
    try {
      var params = new URLSearchParams(location.search);
      var dropped = false;
      for (var i = 0; i < SECRET_PARAMS.length; i += 1) {
        while (params.has(SECRET_PARAMS[i])) {
          params.delete(SECRET_PARAMS[i]);
          dropped = true;
        }
      }
      var rest = params.toString();
      // Пометка нужна: иначе непонятно, была ли страница открыта без
      // параметров или параметры вычистили здесь.
      var mark = dropped ? (rest ? '&' : '?') + 'token=(скрыт)' : '';
      return (location.pathname + (rest ? '?' + rest : '') + mark).slice(0, 300);
    } catch (error) {
      return String(location.pathname || '').slice(0, 300);
    }
  }

  function text(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Подпись элемента - то, что человек видел, когда нажимал.
   *
   * Порядок не случаен. Явная разметка data-journal-label важнее всего: ею
   * подписывают то, что иначе читается плохо. aria-label - следующий по
   * надёжности, он и предназначен для имени элемента. Видимый текст берётся
   * после них и обрезается: в кнопку иногда попадает вся строка таблицы.
   *
   * Для кнопки без подписи (одна иконка) остаётся title, потом имя поля. Если
   * не нашлось ничего - события не будет: строка «нажал» без указания, на что,
   * бесполезна и только зашумляет журнал.
   */
  function labelOf(node) {
    var explicit = text(node.getAttribute && node.getAttribute('data-journal-label'));
    if (explicit) return explicit.slice(0, 120);

    var aria = text(node.getAttribute && node.getAttribute('aria-label'));
    if (aria) return aria.slice(0, 120);

    var own = text(node.innerText || node.textContent);
    if (own && own.length <= 120) return own;
    if (own) return own.slice(0, 117) + '...';

    var title = text(node.getAttribute && node.getAttribute('title'));
    if (title) return title.slice(0, 120);

    var value = text(node.value);
    if (value) return value.slice(0, 120);

    var name = text((node.getAttribute && node.getAttribute('name')) || node.name);
    if (name) return name.slice(0, 120);

    return '';
  }

  /** Что это за элемент - словами, а не тегом. */
  function kindOf(node) {
    var role = text(node.getAttribute && node.getAttribute('role')).toLowerCase();
    if (role === 'tab') return 'закладка';
    if (role === 'menuitem') return 'пункт меню';
    if (role === 'option') return 'вариант списка';
    if (role === 'switch') return 'переключатель';

    var tag = String(node.tagName || '').toLowerCase();
    var type = text(node.getAttribute && node.getAttribute('type')).toLowerCase();
    if (tag === 'a') return 'ссылка';
    if (tag === 'summary') return 'раскрывающийся блок';
    if (type === 'checkbox') return 'отметка';
    if (type === 'radio') return 'выбор';
    return 'кнопка';
  }

  /**
   * Куда именно нажали в разметке - путь из подписанных предков.
   *
   * Одна подпись кнопки часто ничего не решает: «Удалить» есть на десяти
   * страницах, и в журнале нужна не только кнопка, но и место. Берём ближайшие
   * подписанные разделы: заголовок диалога, название закладки, заголовок
   * таблицы. Ограничиваем двумя - дальше идёт разметка страницы, а не смысл.
   */
  function placeOf(node) {
    var parts = [];
    var current = node.parentElement;
    var steps = 0;
    while (current && parts.length < 2 && steps < 12) {
      steps += 1;
      var mark =
        text(current.getAttribute && current.getAttribute('data-journal-place')) ||
        text(current.getAttribute && current.getAttribute('aria-label'));
      if (!mark && current.getAttribute && current.getAttribute('role') === 'dialog') {
        mark = 'диалог';
      }
      if (mark && mark.length <= 80 && parts.indexOf(mark) === -1) parts.push(mark);
      current = current.parentElement;
    }
    return parts.join(' / ');
  }

  function allowed() {
    var now = Date.now();
    if (now - minuteStarted > 60000) {
      minuteStarted = now;
      minuteCount = 0;
    }
    if (minuteCount >= MAX_PER_MINUTE) return false;
    minuteCount += 1;
    return true;
  }

  function push(event) {
    var key = event.action + '|' + event.label + '|' + event.path;
    var now = Date.now();
    if (recent[key] && now - recent[key] < REPEAT_MS) return;
    recent[key] = now;

    if (queue.length >= MAX_BATCH * 4) return; // связи нет и очередь распухла
    queue.push(event);
    if (queue.length >= MAX_BATCH) flush(false);
    else schedule();
  }

  function schedule() {
    if (timer !== null) return;
    timer = window.setTimeout(function () {
      timer = null;
      flush(false);
    }, FLUSH_MS);
  }

  function flush(leaving) {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    if (!queue.length) return;
    var batch = queue.splice(0, MAX_BATCH);
    var body = JSON.stringify({ events: batch });

    var url = ENDPOINT;
    var headers = { 'Content-Type': 'application/json' };
    var token = passToken();
    if (token) {
      if (TOKEN_MODE === 'query') {
        url += (url.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token);
      } else {
        headers.Authorization = 'Bearer ' + token;
      }
    }

    try {
      // keepalive, а не sendBeacon: beacon не умеет заголовки, и у модулей с
      // пропуском в Authorization последняя пачка ушла бы без пропуска - то
      // есть была бы отклонена. keepalive-запрос браузер доводит до конца уже
      // после того, как страница закрылась, ровно для этого он и есть.
      //
      // Beacon остаётся запасным путём: если пропуск в cookie или в адресе,
      // заголовки не нужны, а beacon надёжнее в старых браузерах.
      if (leaving && !headers.Authorization && navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
        return;
      }
      fetch(url, {
        method: 'POST',
        headers: headers,
        body: body,
        credentials: 'same-origin',
        keepalive: true,
      }).catch(function () {
        /* журнал не имеет права мешать работе страницы */
      });
    } catch (error) {
      /* и здесь тоже */
    }
  }

  document.addEventListener(
    'click',
    function (nativeEvent) {
      try {
        if (!nativeEvent || nativeEvent.button !== 0) return;
        var target = nativeEvent.target;
        if (!target || !target.closest) return;

        var node = target.closest(CONTROLS);
        if (!node) return;
        if (node.closest('[data-journal-skip]')) return;

        var label = labelOf(node);
        if (!label) return;
        if (!allowed()) return;

        push({
          action: 'UI_CLICK',
          kind: kindOf(node),
          label: label,
          place: placeOf(node),
          path: safePath(),
          pageTitle: text(document.title).slice(0, 200),
          // Время ставит браузер: до отправки может пройти несколько секунд, а
          // в журнале должно стоять время нажатия, а не время доставки.
          at: new Date().toISOString(),
          tzOffsetMinutes: -new Date().getTimezoneOffset(),
        });
      } catch (error) {
        /* ни одна ошибка здесь не должна касаться пользователя */
      }
    },
    { capture: false, passive: true },
  );

  // Уход со страницы: pagehide надёжнее beforeunload и срабатывает при
  // переходе «назад», когда страница уходит в кеш. visibilitychange добирает
  // случай свёрнутой вкладки на мобильном.
  window.addEventListener('pagehide', function () {
    flush(true);
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush(true);
  });
})();
