-- 048_tenant_aware_rls (применена 20260901120548)

-- 048: изоляция, которую держит БАЗА, а не аккуратность кода.
--
-- Шаг 1 закрыл дыру проверками внутри функций. Этого достаточно ровно до
-- следующего маршрута, где кто-то забудет фильтр: режим отказа снова станет
-- «тихо вернули чужое». Здесь появляется второй, независимый слой — политика
-- на самой таблице.
--
-- Механика: PostgREST выставляет роль из claim `role` и кладёт весь набор
-- claims в `request.jwt.claims`; `auth.jwt()` читает именно её. Воркер
-- подписывает такой токен на каждый запрос, кладя туда `tenant_id`.
--
-- Если claim нет, `auth.jwt() ->> 'tenant_id'` даёт null, сравнение даёт null,
-- строка отсекается. Режим отказа безопасный: не «всё», а «ничего».
--
-- service_role по-прежнему обходит RLS — под ним ходят функции, которым
-- положено видеть несколько кабинетов (приглашения, реестр людей, шаблоны).
-- У них тенант проверяется явно, см. audit_tenant_guards.

do $$
declare t text;
begin
  foreach t in array array[
    'locations','memberships','resources','patients','appointments',
    'appointment_resources','visits','units','materials','analog_groups',
    'batches','techcard_blocks','techcards','services','visit_services',
    'stock_movements','visit_costs','working_hours','schedule_overrides',
    'booking_settings'
  ]
  loop
    -- Сплошной запрет остаётся, но только для anon: голым публичным ключом
    -- к данным кабинета подходить незачем ни при каких условиях.
    execute format('drop policy if exists %I on %I', t || '_deny_direct', t);
    execute format(
      'create policy %I on %I as restrictive for all to anon using (false)',
      t || '_deny_anon', t);

    -- Разрешающая политика для authenticated: видно ровно свой кабинет.
    -- with check закрывает и запись: подсунуть чужой tenant_id в insert
    -- тоже не выйдет.
    execute format($f$
      create policy %I on %I for all to authenticated
        using      (tenant_id = nullif(auth.jwt() ->> 'tenant_id', '')::uuid)
        with check (tenant_id = nullif(auth.jwt() ->> 'tenant_id', '')::uuid)
    $f$, t || '_own_tenant', t);
  end loop;
end $$;

-- Таблицы, которые по смыслу пересекают кабинеты, остаются закрытыми для
-- обеих публичных ролей: к ним ходят только функции под service_role.
--   tenants                — ищется по публичному токену до того, как кабинет известен
--   app_users              — реестр людей, он вне кабинетов
--   catalog_templates и... — общие для платформы
--   subscription_*         — платежи, к ним прикладной клиент не ходит вовсе
comment on table app_users is
  'Вне тенантов. Закрыта для anon и authenticated: доступ только через функции.';;
