-- Открывает данные MDM для PostgREST БЕЗ изменения PGRST_DB_SCHEMAS и БЕЗ
-- перезапуска postgrest/kong. Схема "public" уже входит в список открытых
-- схем (public, erp, warehouse, graphql_public) — вместо того чтобы добавлять
-- туда "mdm" (это требует правки .env стека и рестарта контейнеров на сервере),
-- создаём в "public" простые view "как есть" поверх таблиц mdm.*.
--
-- Простые view вида "select * from одна_таблица" автоматически обновляемые в
-- Postgres — PostgREST может через них не только читать, но и писать
-- (insert/update/delete), как будто это сама таблица.
--
-- Безопасно выполнять повторно: CREATE OR REPLACE VIEW/FUNCTION, GRANT — ничего
-- не удаляет, не трогает "erp"/"warehouse" и существующие таблицы "public".

create or replace view public.mdm_golden_records as select * from mdm.mdm_golden_records;
create or replace view public.mdm_requests as select * from mdm.mdm_requests;
create or replace view public.mdm_cross_reference as select * from mdm.mdm_cross_reference;
create or replace view public.mdm_audit_log as select * from mdm.mdm_audit_log;
create or replace view public.mdm_bus_events as select * from mdm.mdm_bus_events;

grant select, insert, update, delete on public.mdm_golden_records to anon, authenticated, service_role;
grant select, insert, update, delete on public.mdm_requests to anon, authenticated, service_role;
grant select, insert, update, delete on public.mdm_cross_reference to anon, authenticated, service_role;
grant select, insert, update, delete on public.mdm_audit_log to anon, authenticated, service_role;
grant select, insert, update on public.mdm_bus_events to anon, authenticated, service_role;

-- Обёртка над функцией поиска похожих эталонов (настоящий pg_trgm)
create or replace function public.mdm_find_similar(p_entity_type text, p_name text, p_limit int default 5)
returns table(id uuid, normalized_name text, score real) as $$
    select * from mdm.mdm_find_similar(p_entity_type, p_name, p_limit);
$$ language sql stable;

grant execute on function public.mdm_find_similar(text, text, int) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
