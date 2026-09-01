-- 007_expand_techcard_version (применена 20260825092318)

-- Разворот версии техкарты в неизменяемый снимок.
-- Внутрь копируются: состав группы аналогов, коэффициент единицы, содержимое
-- версий блоков и флаг масштабирования — на момент версии. Ссылок на блок в
-- снимке не остаётся, резолвить на чтении нечего.
-- Группа аналогов НЕ резолвится в материал: он выбирается на закрытии по FEFO
-- внутри зафиксированного состава.
create or replace function expand_techcard_version(p_version_id uuid)
returns int
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  inserted int;
begin
  delete from techcard_expanded where techcard_version_id = p_version_id;

  with src as (
    -- Собственные строки техкарты
    select 'line'::text as source,
           tl.material_id, tl.analog_group_id,
           tl.norm_qty, tl.unit_id, tl.scales_with_quantity
      from techcard_lines tl
     where tl.techcard_version_id = p_version_id
       and tl.block_version_id is null
    union all
    -- Строки подключённых блоков: базовый набор кресла, анестезия, изоляция, рентген
    select 'block'::text,
           bl.material_id, bl.analog_group_id,
           bl.norm_qty, bl.unit_id, bl.scales_with_quantity
      from techcard_lines tl
      join techcard_block_lines bl on bl.block_version_id = tl.block_version_id
     where tl.techcard_version_id = p_version_id
       and tl.block_version_id is not null
  )
  insert into techcard_expanded
    (techcard_version_id, source, material_id, analog_group_id, analog_material_ids,
     norm_qty, divisible, scales_with_quantity)
  select p_version_id,
         src.source,
         src.material_id,
         src.analog_group_id,
         coalesce((
           select array_agg(agm.material_id order by agm.priority, agm.material_id)
             from analog_group_members agm
            where agm.group_id = src.analog_group_id
         ), '{}'::uuid[]),
         -- Конвертация в базовую единицу выполняется ЗДЕСЬ и ровно один раз.
         src.norm_qty * u.factor,
         u.divisible,
         src.scales_with_quantity
    from src
    join units u on u.id = src.unit_id;

  get diagnostics inserted = row_count;

  if inserted = 0 then
    raise exception 'версия техкарты % развернулась в ноль строк', p_version_id
      using errcode = 'P0001';
  end if;
  return inserted;
end $$;

revoke all on function expand_techcard_version(uuid) from public, anon, authenticated;;
