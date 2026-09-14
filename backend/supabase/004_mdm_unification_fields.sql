-- П.5 из списка руководителя: настраиваемые "поля унификации" — админ
-- выбирает, по каким полям сущность считается ТОЧНО той же самой (не через
-- нечёткое сходство названия, а через равенство ключевых атрибутов). Пример
-- из задачи: ИИН/БИН для контрагентов, код+название для видов работ.
--
-- Реализовано без новых колонок на mdm_golden_records — "article" (уже несёт
-- код/ИИН-БИН, см. erpClient.js) и "normalized_name" там уже есть. Эта
-- таблица только хранит НАБОР полей (подмножество {article, normalized_name})
-- для каждого entity_type, который считается ключом точного совпадения.
create table if not exists mdm.mdm_unification_fields (
    entity_type text primary key,
    fields text[] not null default '{}',
    updated_by text,
    updated_at timestamptz not null default now()
);

grant all on mdm.mdm_unification_fields to anon, authenticated, service_role;

-- Значения по умолчанию — ровно то, что попросили: контрагент по ИИН/БИН
-- (article), вид работ по коду И названию одновременно (оба должны совпасть,
-- иначе одинаковый код у двух разных по факту работ склеил бы их в одну).
insert into mdm.mdm_unification_fields (entity_type, fields) values
    ('contractor', array['article']),
    ('job', array['article', 'normalized_name'])
on conflict (entity_type) do nothing;

create or replace view public.mdm_unification_fields as select * from mdm.mdm_unification_fields;
grant select, insert, update, delete on public.mdm_unification_fields to anon, authenticated, service_role;

notify pgrst, 'reload schema';
