# MDM — модуль управления мастер-данными (AS Group)

Независимый модуль для ERP Core, разработанный по контракту из
[`MODULE_DEVELOPER_GUIDE.md`](MODULE_DEVELOPER_GUIDE.md) и ТЗ
`Техническое задание (ТЗ)_ Система управления мастер-данными (MDM) для экосистемы AS Group.pdf`,
сверено с уже работающим модулем Склада (`C:\demo_store` — FastAPI + Next.js, порты 8008/8002
в проде, схема `warehouse`, `supabase/*.sql`-миграции, SSO и iframe-заголовки).

> Файлы `App.jsx`, `MDMPage.jsx`, `ProjectsPage.jsx`, `index.css`, `index.js`, `mdm.js` в
> корне — исходный прототип MDM, встроенный вкладкой в модуль «Смета» (УСП). Не менялись,
> оставлены для справки. Рабочий модуль — в `backend/` и `frontend/`.

## Архитектура

**Один порт — 9009.** Backend (Express) отдаёт `/health`, `/api/v1/...` и статику собранного
фронтенда с одного и того же порта — ERP Gateway обращается по единственному адресу.

```
backend/
  supabase/001_mdm_schema.sql   Миграция: схема "mdm" (выполнить 1 раз в Supabase SQL Editor)
  src/
    server.js                    Порт 9009: /health, /api/v1, статика frontend/dist
    config/env.js                .env
    lib/
      pgrest.js                   Клиент к общему self-hosted Supabase (PostgREST/Kong)
      erpClient.js                Кандидаты для дедупликации — из зеркала mdm.<Materials_cas...>
      eventBus.js                 Заглушка Kafka-топиков mdm.raw.requests / mdm.golden.updates
    middleware/auth.js            SSO JWT + роль "Стюард данных"
    routes/{health,mdm,erp,devAuth}.js
    services/matchingService.js   Движок дедупликации (пороги 0.55 / 0.25, pg_trgm)

frontend/
  public/module.json             Контракт модуля (как у Procurement — лежит в public/)
  src/{auth.js,api.js,App.jsx,pages/MDMPage.jsx,components/...}
```

## Где хранятся данные

Общий self-hosted Supabase (`10.66.0.105`) — тот же инстанс, где уже живут схемы `erp` и
`warehouse` (модуль Склада). MDM получил свою схему **`mdm`** — тот же паттерн, что у Склада
(своя схема под свой домен), но **без зеркалирования `erp`**.

Проверила на реальном коде модуля Склада (`C:\demo_store`): он не копирует таблицы `erp.*`
к себе — у него полностью свои таблицы (`items`, `warehouses`, `counterparties`...) в своей
схеме, а с соседними модулями он общается прямыми REST-вызовами (Закупки сами шлют
`POST /api/v1/receipts`). Поэтому MDM тоже не хранит копию `erp` — кандидатов на дедупликацию
читает из `erp` вживую через PostgREST (`Accept-Profile: erp`, см.
`backend/src/lib/erpClient.js`), а схема `mdm` хранит только **свои** рабочие таблицы:

`backend/supabase/001_mdm_schema.sql`, выполняется один раз в Supabase SQL Editor:
1. Создаёт схему `mdm` — без каких-либо чужих таблиц внутри.
2. Создаёт собственные таблицы модуля: `mdm_golden_records`, `mdm_requests`,
   `mdm_cross_reference`, `mdm_audit_log`, `mdm_bus_events`.
3. Включает `pg_trgm` и создаёт `mdm.mdm_find_similar()` — тот самый движок дедупликации из
   ТЗ (настоящий Postgres-`similarity()`, не JS-эмуляция).
4. Выдаёт права ролям `anon/authenticated/service_role` на схему `mdm` — так же, как уже
   настроено для `erp`/`warehouse`.

### ⚠️ Нужно доделать вручную, прежде чем модуль заработает по-настоящему

1. ~~Выполнить `backend/supabase/001_mdm_schema.sql` в Supabase SQL Editor того же проекта.~~
   **Готово** — выполнила через Studio (`api/platform/pg-meta/default/query`). Схема `mdm`,
   все 5 таблиц и функция `mdm.mdm_find_similar()` созданы и проверены; `erp` не тронута.
2. **Добавить `mdm` в список схем, которые видит PostgREST.** Сейчас проверила — отдаёт:
   `Only the following schemas are exposed: public, erp, warehouse, graphql_public`.
   Это конфиг `PGRST_DB_SCHEMAS` в `.env` self-hosted Supabase-стека (там же, где уже
   прописаны `erp` и `warehouse`) — нужно дописать `mdm` и перезапустить контейнер
   `postgrest`/`kong`. **Это должны сделать вы/админ стека** — у меня нет shell-доступа к
   серверу, где крутится сам Docker-стек Supabase (только к базе и Studio), а рестарт
   Kong/PostgREST задевает все остальные модули, которые сейчас на него завязаны.

Как только оба шага сделаны — backend/frontend уже готовы и ничего больше менять не нужно.
Чтение из `erp` (вкладка «Импорт из ERP») уже работает и без этих шагов — туда PostgREST
доступ уже открыт.

## Порты и запуск

Договорились на **порт 9009** для всего модуля (у Procurement 8007/8001, у Склада 8008).

Локальная разработка (два процесса, с hot-reload):
```bash
cd backend && npm install && npm run dev     # http://localhost:9009
cd frontend && npm install && npm run dev    # http://localhost:5183 (проксирует /api на 9009)
```

Прод/финальная проверка одним портом (как в `start-mdm.cmd`):
```bash
cd backend && npm install
cd frontend && npm install && npm run build   # собирает frontend/dist
cd backend && node src/server.js              # отдаёт всё с :9009
```
или просто запустить `start-mdm.cmd` из корня.

## SSO

ERP открывает модуль как `.../?token=<JWT>`. Реализация в точности как в `module_auth.py`
модуля Procurement: HS256, обязательные `sub`/`email`/`role`/`app_metadata.organization_id`.
Пока не подключено к настоящему ERP — на экране входа есть «Тестовый вход»
(`POST /dev/login`, только при `DEV_MODE=true`) — сам подписывает тестовый токен тем же
`JWT_SECRET`.

В отличие от Procurement (там `module_auth.py` написан, но не подключен к роутам — API
работает без проверки) — в MDM SSO реально проверяется на каждый запрос к `/api/v1/*`, и
роль `steward` ("Стюард данных") реально ограничивает `resolve`/`golden-records` (создание).

## Соответствие ТЗ

- Статусы: `new → merged | created | conflict` (конфликт — ручное решение Стюардом).
- Kafka-топики `mdm.raw.requests`/`mdm.golden.updates` — реального брокера нет; события
  журналируются в `mdm.mdm_bus_events`, видны на дашборде. Модуль-к-модулю в этой экосистеме
  по факту ходят прямыми REST-вызовами (см. приёмку из Закупок в Складе, `demo_store/README.md`),
  а не через Kafka — если это устроит, `eventBus.js` можно так же заменить прямым REST-вызовом
  соседнего модуля.
- Роли: Пользователь (заявки) / Стюард данных (`resolve`, прямое заведение эталона).
- Золотая запись: `article`, `material_group`, `base_unit`; Cross-Reference и Аудит-лог —
  вкладка «Золотые записи» → клик по строке.

## Что нужно от вас

1. Выполнить `backend/supabase/001_mdm_schema.sql` в Supabase SQL Editor — могу сама через
   Studio, если разрешите.
2. Добавить `mdm` в `PGRST_DB_SCHEMAS` и перезапустить `postgrest`/`kong` — это ваша сторона,
   у меня нет shell-доступа к серверу самого Docker-стека.
3. `DEV_MODE=false` перед реальным подключением к ERP.
4. Порт для прод-деплоя — **решено, 9009** (см. выше). Остался только сервер/адрес, на
   котором разворачиваем (например, `91.147.81.4`, как у Склада/Procurement) — если это тот
   же сервер, дополнительных действий не нужно, backend уже слушает `:9009`.
