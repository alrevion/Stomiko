-- 058d_cabinet_listing_read

-- Чтение карточки кабинета отдельной функцией, а не запросом к таблице.
--
-- `tenants` не проходит через TenantScope: у неё нет колонки tenant_id, и
-- область кабинета навесила бы фильтр по несуществующему полю. Плюс таблица
-- закрыта для роли authenticated — под токеном кабинета её не прочитать.
-- Прямой запрос служебным ключом обошёл бы оба слоя изоляции разом, поэтому
-- функция с обязательным p_tenant_id, как у всего остального.
create or replace function public.cabinet_listing(p_tenant_id uuid)
returns jsonb
language sql stable security definer set search_path to 'public','extensions' as $$
  select jsonb_build_object(
    'name', t.name, 'city', coalesce(t.city, ''), 'address', coalesce(t.address, ''),
    'landmark', coalesce(t.landmark, ''), 'phone', coalesce(t.contact_phone, ''),
    'listed', t.listed)
    from tenants t where t.id = p_tenant_id;
$$;

revoke all on function public.cabinet_listing(uuid) from public, anon, authenticated;
