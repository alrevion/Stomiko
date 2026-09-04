-- 058e_restore_mode_chosen_at

-- 058 переписала set_user_mode по тексту из 034 и потеряла то, что добавила
-- 035: отметку `mode_chosen_at = now()`. Без неё явный выбор режима не
-- отличался от догадки системы, и врач, нажавший «я пациент», возвращался в
-- свой кабинет — ровно тот баг, ради которого 035 и писалась.
--
-- Урок тот же, что с wipe_demo в 057: функцию нельзя восстанавливать по
-- старой версии файла. У неё позади своя история правок, и «взял текст,
-- добавил своё» стирает всё, что было между.
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
    -- Из 058: публичная ссылка задумана как дверь в кабинет, и этот путь
    -- её обходил — зная id, можно было открыть прайс закрытого кабинета.
    if tid is not null
       and not exists (select 1 from patients p
                        where p.tenant_id = tid and p.telegram_subject = p_subject)
       and not exists (select 1 from memberships m
                        where m.tenant_id = tid and m.subject = p_subject)
       and not exists (select 1 from tenants t where t.id = tid and t.listed) then
      raise exception 'этот кабинет не открыт для записи' using errcode='P0001';
    end if;
  end if;

  -- Из 035: выбор человека и догадка системы — разные вещи.
  update app_users
     set active_mode = p_mode, active_tenant_id = tid, mode_chosen_at = now()
   where subject = p_subject;
  return jsonb_build_object('mode', p_mode, 'tenantId', tid);
end $$;

revoke all on function public.set_user_mode(text,text,uuid) from public, anon, authenticated;
