-- 033_tenant_guard_audit (применена 20260901105416)

-- 033: сторож против повторения.
--
-- Дыра появилась не потому, что кто-то поленился, а потому что ничто не
-- мешало добавить функцию без тенанта. Теперь мешает: preflight падает,
-- если у SECURITY DEFINER-функции нет p_tenant_id и она не в списке
-- осознанных исключений. Список — с причиной у каждой строки, чтобы
-- «просто добавлю сюда» стоило объяснения.

create or replace function public.audit_tenant_guards()
returns table(имя text, аргументы text, причина text)
language sql stable security definer
set search_path to 'public','extensions','pg_catalog' as $$
  select p.proname::text,
         pg_get_function_arguments(p.oid),
         case
           when has_function_privilege('service_role', p.oid, 'execute')
             then 'вызывается снаружи и не требует тенант'
           else 'внутренняя, но без тенанта'
         end
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and p.prokind = 'f'
     and pg_get_function_arguments(p.oid) not like '%p_tenant_id%'
     -- Осознанные исключения:
     and p.proname not in (
       'due_reminders',          -- cron по всем кабинетам сразу
       'mark_reminded',          -- cron, id приходит из due_reminders
       'redeem_staff_invite',    -- тенант выводится из приглашения, оно и есть право
       'new_public_token',       -- ничего не читает
       'rotate_public_token',    -- сам принимает p_tenant_id как единственный аргумент
       'audit_tenant_guards'     -- этот сторож
     )
     -- Беззащитные версии, у которых отобраны права: снаружи не вызвать.
     and has_function_privilege('service_role', p.oid, 'execute')
   order by p.proname;
$$;

comment on function public.audit_tenant_guards() is
  'Пусто = каждая достижимая снаружи функция проверяет кабинет. Непусто = утечка.';;
