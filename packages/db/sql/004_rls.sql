-- Stomiko 004: RLS как защита в глубину.
--
-- ВАЖНО: Worker ходит в базу под service_role, который обходит RLS. Значит RLS
-- НЕ является стражем изоляции тенантов — страж это репозиторный слой
-- tenantScoped() плюс линт-запрет прямого supabase.from() вне репозиториев.
-- Режим отказа сменился: не «GUC не выставлен → молча ноль строк», а
-- «забыл .eq(tenant_id) → утечка между тенантами».
--
-- RLS здесь закрывает другой сценарий: если когда-нибудь появится клиент,
-- ходящий в Supabase напрямую с anon/authenticated ключом, он не увидит ничего.
-- В прототипе такого клиента нет: Mini App и SPA ходят только в наш Worker.

do $$
declare t text;
begin
  foreach t in array array[
    'tenants','locations','memberships','resources','patients','appointments',
    'appointment_resources','visits','units','materials','analog_groups',
    'analog_group_members','batches','techcard_blocks','techcard_block_versions',
    'techcard_block_lines','techcards','techcard_versions','techcard_lines',
    'techcard_expanded','services','visit_services','stock_movements','visit_costs'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy %I on %I as restrictive for all to anon, authenticated using (false)',
      t || '_deny_direct', t
    );
  end loop;
end $$;
