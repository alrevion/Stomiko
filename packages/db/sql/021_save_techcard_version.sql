-- 021_save_techcard_version (применена 20260825102859)

-- Правка техкарты создаёт НОВУЮ версию и переводит услугу на неё.
-- Старая версия остаётся нетронутой: приёмы, закрытые по ней, обязаны считаться
-- по тем нормам, что действовали в момент оказания.
create or replace function save_techcard_version(
  p_service_id uuid, p_lines jsonb
) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare
  svc services%rowtype;
  old_ver techcard_versions%rowtype;
  tc_id uuid; new_ver uuid; next_n int; expanded int;
begin
  select * into svc from services where id = p_service_id;
  if not found then raise exception 'услуга не найдена' using errcode='P0002'; end if;
  if jsonb_array_length(p_lines) = 0 then
    raise exception 'техкарта не может быть пустой' using errcode='P0001';
  end if;

  select * into old_ver from techcard_versions where id = svc.techcard_version_id;
  tc_id := old_ver.techcard_id;
  select coalesce(max(version),0)+1 into next_n from techcard_versions where techcard_id = tc_id;

  insert into techcard_versions (techcard_id, version) values (tc_id, next_n) returning id into new_ver;

  -- Строки-блоки переносятся как есть: их состав правится на уровне библиотеки,
  -- а не внутри отдельной техкарты — иначе «сменил перчатки» = 76 правок.
  insert into techcard_lines (techcard_version_id, block_version_id)
  select new_ver, tl.block_version_id
    from techcard_lines tl
   where tl.techcard_version_id = old_ver.id and tl.block_version_id is not null;

  insert into techcard_lines
    (techcard_version_id, material_id, analog_group_id, norm_qty, unit_id, scales_with_quantity)
  select new_ver,
         nullif(l->>'materialId','')::uuid,
         nullif(l->>'analogGroupId','')::uuid,
         (l->>'normQty')::numeric,
         (l->>'unitId')::uuid,
         coalesce((l->>'scalesWithQuantity')::boolean, true)
    from jsonb_array_elements(p_lines) l
   where (l->>'normQty')::numeric > 0;

  expanded := expand_techcard_version(new_ver);
  update services set techcard_version_id = new_ver where id = p_service_id;

  return jsonb_build_object('versionId', new_ver, 'version', next_n, 'expandedLines', expanded);
end $$;

revoke all on function save_techcard_version(uuid, jsonb) from public, anon, authenticated;;
