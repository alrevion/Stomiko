-- 011_reconcile_batches (применена 20260825092629)

-- Сверка кэшированной проекции с журналом.
-- Журнал — истина, batches.qty_remaining — его проекция, поэтому инвариант
-- ровно один: qty_remaining = Σ(qty_delta по партии). initial_qty при этом просто
-- денормализованная копия прихода, нужная формуле доли партии.
-- Вызывается при каждом открытии складского экрана, а не только в тестах:
-- кэшированная проекция расходится тихо, и в проде это всплыло бы через месяцы.
create or replace function reconcile_batches(p_tenant_id uuid)
returns table (batch_id uuid, material_ru text, cached numeric, journal numeric, diff numeric)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select b.id, m.name_ru, b.qty_remaining,
         coalesce(sum(sm.qty_delta), 0) as journal,
         b.qty_remaining - coalesce(sum(sm.qty_delta), 0) as diff
    from batches b
    join materials m on m.id = b.material_id
    left join stock_movements sm on sm.batch_id = b.id
   where b.tenant_id = p_tenant_id
   group by b.id, m.name_ru, b.qty_remaining
  having b.qty_remaining <> coalesce(sum(sm.qty_delta), 0);
$$;

revoke all on function reconcile_batches(uuid) from public, anon, authenticated;;
