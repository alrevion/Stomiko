-- 077_own_cabinet_is_always_open

-- Свой кабинет открыт всегда, даже если он не в поиске.
--
-- `choose_public_cabinet` пускала только в опубликованные кабинеты — правило
-- верное для НЕЗНАКОМОГО кабинета: публикация и есть дверь, иначе, зная
-- идентификатор, можно было бы открыть прайс закрытого кабинета.
--
-- Но у человека, который уже лечится в кабинете, дверь другая: у него там
-- карточка. А большинство частных кабинетов в поиске не показываются — они
-- работают по ссылке. Получалось, что вернуться к своему стоматологу нельзя:
-- переключение отвечало «кабинет не открыт для записи» про кабинет, где
-- человек лечится третий год.
--
-- Правило теперь читается целиком: пускаем, если кабинет открыт публично
-- ИЛИ человек в нём уже свой.
create or replace function public.choose_public_cabinet(p_subject text, p_tenant_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions' as $$
declare nm text;
begin
  select t.name into nm
    from tenants t
   where t.id = p_tenant_id
     and (t.listed
          or exists (select 1 from patients p
                      where p.tenant_id = t.id and p.telegram_subject = p_subject));
  if nm is null then
    raise exception 'кабинет не открыт для записи' using errcode='P0002';
  end if;
  update app_users
     set active_mode = 'patient', active_tenant_id = p_tenant_id, mode_chosen_at = now()
   where subject = p_subject;
  return jsonb_build_object('tenantId', p_tenant_id, 'cabinet', nm);
end $$;

revoke all on function public.choose_public_cabinet(text,uuid) from public, anon, authenticated;
