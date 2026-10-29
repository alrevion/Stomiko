-- 058c_hide_frozen_from_search

-- Замороженный кабинет не принимает записи: пациент получает «кабинет на
-- паузе» вместо выбора времени. Показывать такой в поиске — приводить
-- человека в закрытую дверь, причём по нашей же наводке.
--
-- Здесь же появляется сама витрина в рабочем виде. Порядок — по ближайшему
-- свободному времени, нейтральный намеренно: как только в выдаче появляется
-- «рекомендуем», платформа отвечает за выбор врача, а отвечать ей нечем.
--
-- Отдельная функция с ОТДЕЛЬНЫМ набором полей, а не «те же данные с
-- фильтром»: это единственное место, где что-то о кабинете видно за его
-- пределами, и состав выдачи должен быть виден целиком в одном месте.
--
-- ponytail: ближайший слот считается на каждый кабинет отдельно, то есть
-- стоимость линейна по числу опубликованных. На десятках незаметно; на
-- сотнях — считать раз в несколько минут и класть в колонку.
create or replace function public.public_cabinets(
  p_city text default null, p_query text default null
) returns table (
  tenant_id uuid, name text, doctor text, city text, address text,
  landmark text, phone text, consult_price numeric, next_slot timestamptz
)
language sql stable security definer set search_path to 'public','extensions' as $$
  select x.tenant_id, x.name, x.doctor, x.city, x.address, x.landmark,
         x.phone, x.consult_price, x.next_slot
    from (
      select t.id as tenant_id, t.name,
             -- «Врач» — это заглушка из справочника ресурсов, а не имя.
             (select r.name from resources r
               where r.tenant_id = t.id and r.kind = 'practitioner'
                 and r.name not in ('Врач', 'Доктор', '') limit 1) as doctor,
             t.city, t.address, t.landmark, t.contact_phone as phone,
             s.price as consult_price,
             (select min(sl.slot_start)
                from available_slots(
                       t.id,
                       (select r.id from resources r
                         where r.tenant_id = t.id and r.kind = 'chair' limit 1),
                       s.id,
                       (now() at time zone t.timezone)::date,
                       ((now() + interval '14 days') at time zone t.timezone)::date) sl
             ) as next_slot
        from tenants t
        -- Условие то же, что у самой заморозки: оплачено по сегодня.
        join subscriptions sub on sub.tenant_id = t.id and sub.paid_until >= now()
        left join lateral (
          -- Первичный приём: по нему пациент сравнивает кабинеты. Коды B01 —
          -- приёмы врача в номенклатуре услуг.
          select sv.id, sv.price from services sv
           where sv.tenant_id = t.id and sv.bookable
           order by (sv.code like 'B01.%') desc, sv.price
           limit 1) s on true
       where t.listed
         and (nullif(trim(coalesce(p_city, '')), '') is null
              or lower(t.city) = lower(trim(p_city)))
         and (nullif(trim(coalesce(p_query, '')), '') is null
              or t.name ilike '%' || trim(p_query) || '%'
              or coalesce(t.address, '') ilike '%' || trim(p_query) || '%'
              or coalesce(t.landmark, '') ilike '%' || trim(p_query) || '%')
    ) x
   order by x.next_slot nulls last, x.name;
$$;

create or replace function public.public_cities()
returns table (city text, cabinets int)
language sql stable security definer set search_path to 'public','extensions' as $$
  select t.city, count(*)::int from tenants t
   join subscriptions sub on sub.tenant_id = t.id and sub.paid_until >= now()
   where t.listed and t.city is not null
   group by t.city order by 2 desc, 1;
$$;

revoke all on function public.public_cabinets(text,text) from public, anon, authenticated;
revoke all on function public.public_cities() from public, anon, authenticated;
