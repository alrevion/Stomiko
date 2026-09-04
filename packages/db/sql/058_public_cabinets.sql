-- 058_public_cabinets

-- Пациент без ссылки упирался в тупик «нужна ссылка врача». Между тем это
-- ровно тот человек, за которого платят рекламой: увидел объявление, нажал,
-- пришёл — и делать ему здесь было нечего.
--
-- Адреса в схеме не было вообще: ни у кабинета, ни у филиала. А стоматолога
-- выбирают по вопросу «кто рядом», а не «какие бывают». Ориентир отдельным
-- полем: в Ташкенте «напротив Чорсу» работает лучше названия улицы, а
-- склеенный с адресом он терялся бы в поиске.
--
-- ВНИМАНИЕ: две функции этой миграции пришлось чинить следом.
--   set_cabinet_listing — локальные переменные назывались как колонки, и
--     `set city = city` молча не записывало ничего (058b);
--   set_user_mode — переписана по тексту из 034 и потеряла отметку
--     mode_chosen_at, добавленную в 035; вернулся баг, который 035 чинила
--     (058e). Восстанавливать функцию по старой версии файла нельзя: у неё
--     позади своя история правок.
alter table tenants add column city     text;
alter table tenants add column address  text;
alter table tenants add column landmark text;

-- Показ — решение врача, а не платформы: публикация выносит наружу его имя
-- и телефон. По умолчанию выключено и включается только явно.
alter table tenants add column listed boolean not null default false;

create index tenants_listed_idx on tenants (listed) where listed;

/** Города, в которых есть открытые кабинеты. Фильтр строится по факту. */
create or replace function public.public_cities()
returns table (city text, cabinets int)
language sql stable security definer set search_path to 'public','extensions' as $$
  select t.city, count(*)::int from tenants t
   where t.listed and t.city is not null
   group by t.city order by 2 desc, 1;
$$;

/**
 * Выбор кабинета из поиска.
 *
 * Право войти даёт публикация, а не знание идентификатора: закрытый кабинет
 * этой дверью не открывается, даже если его id откуда-то известен.
 */
create or replace function public.choose_public_cabinet(p_subject text, p_tenant_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions' as $$
declare nm text;
begin
  select name into nm from tenants where id = p_tenant_id and listed;
  if nm is null then
    raise exception 'кабинет не открыт для записи' using errcode='P0002';
  end if;
  update app_users
     set active_mode = 'patient', active_tenant_id = p_tenant_id, mode_chosen_at = now()
   where subject = p_subject;
  return jsonb_build_object('tenantId', p_tenant_id, 'cabinet', nm);
end $$;

/**
 * Смена режима: кабинет пациента теперь проверяется.
 *
 * Раньше ветка пациента принимала ЛЮБОЙ идентификатор кабинета без проверки.
 * Утечкой это не было — данные защищены политикой и проверками в функциях, —
 * но публичная ссылка задумана как дверь в кабинет, а этот путь её обходил:
 * зная id, можно было открыть прайс закрытого кабинета и записаться.
 */
create or replace function public.set_user_mode(
  p_subject text, p_mode text, p_tenant_id uuid default null)
returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare tid uuid;
begin
  if p_mode not in ('patient','doctor') then
    raise exception 'неизвестный режим' using errcode='P0001';
  end if;

  if p_mode = 'doctor' then
    select m.tenant_id into tid from memberships m
     where m.subject = p_subject
       and (p_tenant_id is null or m.tenant_id = p_tenant_id)
     order by (m.tenant_id = p_tenant_id) desc
     limit 1;
    if tid is null then
      raise exception 'у вас нет доступа к этому кабинету' using errcode='P0001';
    end if;
  else
    tid := p_tenant_id;
    if tid is not null
       and not exists (select 1 from patients p
                        where p.tenant_id = tid and p.telegram_subject = p_subject)
       and not exists (select 1 from memberships m
                        where m.tenant_id = tid and m.subject = p_subject)
       and not exists (select 1 from tenants t where t.id = tid and t.listed) then
      raise exception 'этот кабинет не открыт для записи' using errcode='P0001';
    end if;
  end if;

  update app_users set active_mode = p_mode, active_tenant_id = tid
   where subject = p_subject;
  return jsonb_build_object('mode', p_mode, 'tenantId', tid);
end $$;

revoke all on function public.public_cities() from public, anon, authenticated;
revoke all on function public.choose_public_cabinet(text,uuid) from public, anon, authenticated;

-- Витрина и список городов тенанта не принимают ОСОЗНАННО: они по смыслу
-- пересекают кабинеты и отдают только то, что кабинет сам открыл.
create or replace function public.audit_tenant_guards()
returns table(имя text, аргументы text, причина text)
language sql stable security definer
set search_path to 'public','extensions','pg_catalog' as $$
  select p.proname::text, pg_get_function_arguments(p.oid),
         'достижима снаружи и не проверяет кабинет'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'
     and pg_get_function_arguments(p.oid) not like '%p_tenant_id%'
     and p.proname not in (
       'due_reminders', 'mark_reminded', 'redeem_staff_invite',
       'new_public_token', 'rotate_public_token', 'audit_tenant_guards',
       'touch_app_user', 'user_context', 'set_user_mode', 'my_appointments',
       'confirm_appointment', 'my_treatment_plans',
       'material_unit_price', 'tg_close_plan_items',
       'public_cabinets', 'public_cities',
       'set_verified_phone', 'normalize_phone',
       'provision_tenant', 'provision_tenant_core', 'available_templates',
       'template_health', 'subscription_plans_list', 'due_subscription_notices',
       'rls_health', 'prune_access_log'
     )
     and has_function_privilege('service_role', p.oid, 'execute')
   order by p.proname;
$$;
