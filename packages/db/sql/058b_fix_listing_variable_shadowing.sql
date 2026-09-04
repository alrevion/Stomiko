-- 058b_fix_listing_variable_shadowing

-- Локальные переменные назывались как колонки: `set city = city` — это
-- присваивание колонки самой себе, и функция молча не записывала ничего.
-- Проверки при этом проходили, ошибок не было, ответ выглядел успешным.
--
-- Ровно та же ошибка, что в 030 с переменной цикла. Признак один и тот же:
-- операция «прошла», а данные не изменились. Префикс v_ снимает совпадение.
create or replace function public.set_cabinet_listing(
  p_tenant_id uuid, p_city text, p_address text, p_landmark text,
  p_phone text, p_listed boolean
) returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions' as $$
declare v_city text; v_addr text; v_land text; v_phone text;
begin
  v_city  := nullif(trim(coalesce(p_city, '')), '');
  v_addr  := nullif(trim(coalesce(p_address, '')), '');
  v_land  := nullif(trim(coalesce(p_landmark, '')), '');
  v_phone := nullif(trim(coalesce(p_phone, '')), '');

  -- Опубликовать без города, адреса и телефона нельзя: карточка без них не
  -- отвечает ни на один вопрос пациента, а место в списке занимает.
  if p_listed and (v_city is null or v_addr is null or v_phone is null) then
    raise exception 'чтобы кабинет появился в поиске, укажите город, адрес и телефон'
      using errcode='P0001';
  end if;

  update tenants
     set city = v_city, address = v_addr, landmark = v_land,
         contact_phone = v_phone, listed = p_listed
   where id = p_tenant_id;
  if not found then raise exception 'кабинет не найден' using errcode='P0002'; end if;

  return jsonb_build_object('listed', p_listed, 'city', v_city, 'address', v_addr,
                            'landmark', v_land, 'phone', v_phone);
end $$;

revoke all on function public.set_cabinet_listing(uuid,text,text,text,text,boolean)
  from public, anon, authenticated;
