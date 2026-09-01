-- 022_techcard_editor_views (применена 20260825103009)

-- Исходные строки версии для редактора: материал/группа, норма, единица.
-- Именно исходные, а не развёрнутый снимок: снимок неизменяем, править его
-- значило бы менять себестоимость уже закрытых приёмов.
create or replace function techcard_own_lines(p_version_id uuid)
returns table (
  line_id uuid, material_id uuid, material_ru text,
  analog_group_id uuid, analog_group_name text,
  norm_qty numeric, unit_id uuid, unit_ru text, divisible boolean,
  scales_with_quantity boolean, reference_price numeric
)
language sql stable security definer set search_path = public, extensions
as $$
  select tl.id, tl.material_id, m.name_ru, tl.analog_group_id, ag.name,
         tl.norm_qty, tl.unit_id, u.name_ru, u.divisible,
         tl.scales_with_quantity, m.reference_price
    from techcard_lines tl
    left join materials m      on m.id = tl.material_id
    left join analog_groups ag on ag.id = tl.analog_group_id
    left join units u          on u.id = tl.unit_id
   where tl.techcard_version_id = p_version_id
     and tl.block_version_id is null
   order by coalesce(m.name_ru, ag.name);
$$;

-- Подключённые блоки — только для чтения: их состав общий для десятков карт,
-- и правится он на уровне библиотеки.
create or replace function techcard_block_summary(p_version_id uuid)
returns table (block_code text, block_ru text, lines bigint, version int)
language sql stable security definer set search_path = public, extensions
as $$
  select b.code, b.name_ru,
         (select count(*) from techcard_block_lines bl where bl.block_version_id = bv.id),
         bv.version
    from techcard_lines tl
    join techcard_block_versions bv on bv.id = tl.block_version_id
    join techcard_blocks b on b.id = bv.block_id
   where tl.techcard_version_id = p_version_id
   order by b.code;
$$;

revoke all on function techcard_own_lines(uuid) from public, anon, authenticated;
revoke all on function techcard_block_summary(uuid) from public, anon, authenticated;;
