-- 056_service_cost_parts

-- Расход техкарты делится на две части: постоянную (набор кресла, анестезия,
-- изоляция — один раз на приём) и переменную (на каждый канал, зуб,
-- поверхность). Зависимость от кратности строго линейная, поэтому двух чисел
-- достаточно, чтобы посчитать любую: base + per_unit * quantity.
--
-- Нужно это редактору плана: он показывает маржу, пока врач набирает состав.
-- Запрашивать себестоимость на каждое нажатие «+» значило бы делать запрос
-- на каждое нажатие.
create or replace function public.service_cost_parts(p_tenant_id uuid)
returns table (service_id uuid, base numeric, per_unit numeric, unpriced int)
language sql stable security definer set search_path to 'public','extensions' as $$
  select s.id,
         -- c1 = base + per_unit; c2 = base + 2*per_unit  =>  base = 2*c1 - c2
         round(2 * c1.cost - c2.cost, 2),
         round(c2.cost - c1.cost, 2),
         c1.unpriced_lines
    from services s
    cross join lateral public.service_expected_cost(p_tenant_id, s.id, 1) c1
    cross join lateral public.service_expected_cost(p_tenant_id, s.id, 2) c2
   where s.tenant_id = p_tenant_id;
$$;

revoke all on function public.service_cost_parts(uuid) from public, anon, authenticated;
