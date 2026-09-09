-- 082_checkup_for_every_specialty

-- Профилактический осмотр — услуга, которая есть у любого стоматолога.
--
-- Пациент, у которого болит, не выбирает услугу: он не знает, пломба это
-- или коронка. До сих пор ему показывали список из восьми названий и
-- первичный приём где-то в нём — то есть просили поставить диагноз до
-- визита. Осмотр стоит первым и выбран заранее; всё остальное — для тех
-- немногих, кто уже знает своё лечение.
--
-- Пятнадцать минут: осмотр — это посмотреть и сказать, а не лечить. Врач
-- поправит и время, и цену, как и всё остальное в справочнике.
--
-- Расход — базовый набор кресла и ничего сверх: смотрят зеркалом. Ставить
-- сюда анестезию или изоляцию значило бы завысить себестоимость самой
-- частой услуги кабинета.

insert into template_services (template_id, code, name_ru, name_uz, price, unit_of_norm, duration_minutes, bookable, techcard_name_ru)
select t.id, 'A01.07.001', 'Профилактический осмотр', 'Profilaktik koʻrik',
       150000, 'session', 15, true, 'Профилактический осмотр'
  from catalog_templates t
 where t.is_active
   and not exists (select 1 from template_services x
                    where x.template_id = t.id and x.code = 'A01.07.001');

insert into template_techcard_lines (service_id, block_code, scales_with_quantity)
select s.id, 'base', true
  from template_services s
  join catalog_templates t on t.id = s.template_id and t.is_active
 where s.code = 'A01.07.001'
   and not exists (select 1 from template_techcard_lines x
                    where x.service_id = s.id and x.block_code = 'base');

-- Кабинеты, заведённые до этой правки, тоже должны принимать на осмотр:
-- иначе правило «осмотр есть у любого стоматолога» держалось бы только для
-- новых, а старые остались бы с прайсом процедур.
insert into services (tenant_id, code, name_ru, name_uz, price, unit_of_norm, duration_minutes, bookable)
select t.id, 'A01.07.001', 'Профилактический осмотр', 'Profilaktik koʻrik',
       150000, 'session', 15, true
  from tenants t
 where not exists (select 1 from services s
                    where s.tenant_id = t.id and s.code = 'A01.07.001');

-- Техкарта осмотра в уже живущих кабинетах: одна версия, один блок.
-- Без техкарты приём закроется «без цены», и врач увидит прочерк там, где
-- ждал число.
with новые as (
  select s.id as service_id, s.tenant_id
    from services s
   where s.code = 'A01.07.001' and s.techcard_version_id is null
), карты as (
  insert into techcards (tenant_id, name_ru, name_uz)
  select n.tenant_id, 'Профилактический осмотр', 'Profilaktik koʻrik' from новые n
  returning id, tenant_id
), пары as (
  select k.id as techcard_id, n.service_id, k.tenant_id
    from карты k
    join новые n on n.tenant_id = k.tenant_id
), версии as (
  insert into techcard_versions (techcard_id, version)
  select p.techcard_id, 1 from пары p
  returning id, techcard_id
), строки as (
  insert into techcard_lines (techcard_version_id, block_version_id, scales_with_quantity)
  select v.id, bv.id, true
    from версии v
    join пары p on p.techcard_id = v.techcard_id
    join techcard_blocks b on b.tenant_id = p.tenant_id and b.code = 'base'
    join techcard_block_versions bv on bv.block_id = b.id
  returning techcard_version_id
)
update services s
   set techcard_version_id = v.id
  from версии v join пары p on p.techcard_id = v.techcard_id
 where s.id = p.service_id;
