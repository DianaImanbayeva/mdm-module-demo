-- Добавляет хранение переводов (ru/en/ka/az) прямо в эталон — тянуть их из
-- erp.localization на каждый показ страницы дорого (десятки/сотни тысяч строк),
-- поэтому при синхронизации переводы читаются один раз и складываются сюда.
-- Безопасно выполнять повторно: ADD COLUMN IF NOT EXISTS, ничего не удаляет.

alter table mdm.mdm_golden_records add column if not exists translations jsonb not null default '{}'::jsonb;
alter table mdm.mdm_golden_records add column if not exists unit_translations jsonb not null default '{}'::jsonb;

create or replace view public.mdm_golden_records as select * from mdm.mdm_golden_records;
grant select, insert, update, delete on public.mdm_golden_records to anon, authenticated, service_role;

notify pgrst, 'reload schema';
