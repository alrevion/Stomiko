-- 015_margin_by_service (применена 20260825100210)

-- Маржа по услуге считается ЦЕЛИКОМ в БД.
--
-- Предыдущая версия тянула stock_movements в воркер и агрегировала в JS.
-- PostgREST по умолчанию отдаёт не более 1000 строк, а месяц работы кабинета
-- даёт около 4900 движений — они молча обрезались, и себестоимость выходила
-- в семь раз меньше настоящей. Отчёт показывал 97% вместо 86%: цифра
-- правдоподобная и неверная, то есть худший из возможных вариантов.
--
-- Себестоимость приёма распределяется по услугам пропорционально их выручке:
-- движения не помнят, какой услуге принадлежат. Для точной разбивки нужен
-- visit_service_id в stock_movements — это отдельная работа.
create or replace function margin_by_service(
  p_tenant_id uuid, p_from date, p_to date
) returns table (
  service_id uuid, name_ru text, unit_of_norm text,
  qty bigint, revenue numeric, cost numeric,
  shortfall_cost numeric, unpriced_visits bigint
)
language sql stable security definer set search_path = public, extensions
as $$
  with visit_totals as (
    select v.id,
           coalesce(sum(vs.price), 0) as revenue
      from visits v
      join visit_services vs on vs.visit_id = v.id
     where v.tenant_id = p_tenant_id
       and v.status = 'closed'
       and v.visit_date between p_from and p_to
     group by v.id
  ),
  visit_costs_agg as (
    select vt.id,
           vt.revenue,
           coalesce((select sum(sm.cost) from stock_movements sm
                      where sm.visit_id = vt.id and sm.kind in ('consume','shortfall')
                        and sm.cost is not null), 0) as cost,
           coalesce((select sum(sm.cost) from stock_movements sm
                      where sm.visit_id = vt.id and sm.kind = 'shortfall'
                        and sm.cost is not null), 0) as shortfall,
           exists (select 1 from stock_movements sm
                    where sm.visit_id = vt.id and sm.unpriced) as has_unpriced
      from visit_totals vt
  )
  select s.id, s.name_ru, s.unit_of_norm,
         sum(vs.quantity)::bigint,
         sum(vs.price),
         -- Доля приёма, приходящаяся на услугу, по её вкладу в выручку.
         sum(vca.cost * (vs.price / nullif(vca.revenue, 0))),
         sum(vca.shortfall * (vs.price / nullif(vca.revenue, 0))),
         count(*) filter (where vca.has_unpriced)::bigint
    from visit_services vs
    join visit_costs_agg vca on vca.id = vs.visit_id
    join services s on s.id = vs.service_id
   group by s.id, s.name_ru, s.unit_of_norm
   order by sum(vs.price) - sum(vca.cost * (vs.price / nullif(vca.revenue, 0))) desc;
$$;

revoke all on function margin_by_service(uuid, date, date) from public, anon, authenticated;;
