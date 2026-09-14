-- MDM: собственная схема модуля в общем self-hosted Supabase (тот же инстанс,
-- где живёт "erp" и "warehouse" — модуль Склада уже использует такую же схему
-- под свой домен, поэтому MDM повторяет этот же паттерн: своя схема только
-- под СВОИ рабочие таблицы).
--
-- ERP (схема "erp") сюда НЕ копируется. Склад, судя по его коду, тоже не
-- зеркалирует чужие схемы — у каждого модуля свои таблицы под свой домен,
-- а обмен между модулями идёт прямыми REST-вызовами. Кандидатов на
-- дедупликацию MDM читает из "erp" вживую через PostgREST (Accept-Profile:
-- erp) — см. backend/src/lib/erpClient.js. Так нет второй, стареющей копии
-- данных, и не нужно ничего пересинхронизировать.
--
-- Безопасно выполнять повторно: только CREATE TABLE/FUNCTION IF NOT EXISTS —
-- ничего не удаляет и не трогает схему "erp".
--
-- Выполнить один раз в Supabase SQL Editor (как это делается для остальных
-- модулей — см. корневой README.md).

create schema if not exists mdm;
create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists pg_trgm;    -- тот же движок дедупликации, что в ТЗ

-- ── Собственные рабочие таблицы модуля MDM ──────────────────────────────────

create table if not exists mdm.mdm_golden_records (
    id uuid primary key default gen_random_uuid(),   -- global_guid (термин из ТЗ)
    entity_type text not null,
    normalized_name text not null,
    article text,
    material_group text,
    base_unit text,
    status text not null default 'active',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists mdm.mdm_requests (
    id uuid primary key default gen_random_uuid(),
    source_system text not null,
    local_id text,
    entity_type text not null,
    raw_name text not null,
    raw_attributes jsonb not null default '{}'::jsonb,
    status text not null default 'new',
    match_golden_id uuid references mdm.mdm_golden_records(id),
    match_score real,
    candidates jsonb not null default '[]'::jsonb,
    resolved_golden_id uuid references mdm.mdm_golden_records(id),
    resolved_at timestamptz,
    resolved_by text,
    created_at timestamptz not null default now()
);

create table if not exists mdm.mdm_cross_reference (
    golden_id uuid not null references mdm.mdm_golden_records(id),
    system_code text not null,
    local_system_id text not null,
    created_at timestamptz not null default now(),
    primary key (golden_id, system_code, local_system_id)
);

create table if not exists mdm.mdm_audit_log (
    id uuid primary key default gen_random_uuid(),
    golden_id uuid,
    action text not null,
    actor text,
    organization_id text,
    details jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

-- "Мониторинг шины" (эмуляция Kafka-топиков mdm.raw.requests / mdm.golden.updates
-- из ТЗ до подключения настоящего брокера — см. backend/src/lib/eventBus.js)
create table if not exists mdm.mdm_bus_events (
    id uuid primary key default gen_random_uuid(),
    topic text not null,
    payload jsonb not null default '{}'::jsonb,
    status text not null default 'delivered',
    created_at timestamptz not null default now()
);

create index if not exists idx_mdm_requests_status on mdm.mdm_requests(status);
create index if not exists idx_mdm_requests_entity on mdm.mdm_requests(entity_type);
create index if not exists idx_mdm_golden_entity on mdm.mdm_golden_records(entity_type, status);
create index if not exists idx_mdm_crossref_golden on mdm.mdm_cross_reference(golden_id);

-- Поиск похожих эталонов через настоящий pg_trgm (как в ТЗ), а не через JS-эмуляцию
create or replace function mdm.mdm_find_similar(p_entity_type text, p_name text, p_limit int default 5)
returns table(id uuid, normalized_name text, score real) as $$
    select g.id, g.normalized_name, similarity(g.normalized_name, p_name) as score
    from mdm.mdm_golden_records g
    where g.entity_type = p_entity_type and g.status = 'active'
    order by score desc
    limit p_limit;
$$ language sql stable;

-- ── Права для ролей PostgREST (как уже настроено для схем erp/warehouse) ───
grant usage on schema mdm to anon, authenticated, service_role;
grant all on all tables in schema mdm to anon, authenticated, service_role;
grant all on all sequences in schema mdm to anon, authenticated, service_role;
grant execute on function mdm.mdm_find_similar(text, text, int) to anon, authenticated, service_role;
alter default privileges in schema mdm grant all on tables to anon, authenticated, service_role;
alter default privileges in schema mdm grant all on sequences to anon, authenticated, service_role;

-- Даём PostgREST знать, что схема появилась/обновилась (если он слушает канал pgrst)
notify pgrst, 'reload schema';
