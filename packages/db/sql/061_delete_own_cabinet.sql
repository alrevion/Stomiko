-- 061_delete_own_cabinet

-- Удаление кабинета из приложения.
--
-- delete_tenant существовала, но вызывалась только из скриптов уборки. Дать
-- к ней кнопку — значит дать человеку в два касания стереть карты пациентов,
-- историю приёмов и себестоимость за всё время. Поэтому здесь две функции:
-- одна СЧИТАЕТ, что исчезнет, вторая удаляет и только владельцу.
--
-- «Вы уверены?» без цифр — вопрос ни о чём: человек не помнит, сколько у
-- него пациентов. Вопрос со счётом — уже решение.

/** Что именно исчезнет вместе с кабинетом. Для окна подтверждения. */
create or replace function public.cabinet_scale(p_tenant_id uuid)
returns jsonb
language sql stable security definer set search_path to 'public','extensions' as $$
  select jsonb_build_object(
    'name',        (select name from tenants where id = p_tenant_id),
    'patients',    (select count(*) from patients     where tenant_id = p_tenant_id),
    'visits',      (select count(*) from visits       where tenant_id = p_tenant_id and status = 'closed'),
    'appointments',(select count(*) from appointments where tenant_id = p_tenant_id
                                                        and status = 'scheduled' and starts_at >= now()),
    'plans',       (select count(*) from treatment_plans where tenant_id = p_tenant_id),
    'payments',    (select count(*) from payments     where tenant_id = p_tenant_id),
    'materials',   (select count(*) from materials    where tenant_id = p_tenant_id),
    'staff',       (select count(*) from memberships  where tenant_id = p_tenant_id));
$$;

/**
 * Удаление кабинета владельцем.
 *
 * Право проверяется здесь, а не в приложении: маршрут можно забыть закрыть,
 * а это единственная в системе операция, которую нельзя отменить.
 */
create or replace function public.delete_own_cabinet(p_tenant_id uuid, p_subject text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions' as $$
declare r text;
begin
  select role into r from memberships where tenant_id = p_tenant_id and subject = p_subject;
  if r is null then raise exception 'вы не работаете в этом кабинете' using errcode='P0001'; end if;
  if r <> 'owner' then raise exception 'удалить кабинет может только владелец' using errcode='P0001'; end if;
  return public.delete_tenant(p_tenant_id);
end $$;

/**
 * Выход сотрудника из кабинета.
 *
 * Владельцу закрыт: кабинет без владельца никому не принадлежит, и данные в
 * нём останутся без того, кто за них отвечает.
 */
create or replace function public.leave_cabinet(p_tenant_id uuid, p_subject text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions' as $$
declare r text;
begin
  select role into r from memberships where tenant_id = p_tenant_id and subject = p_subject;
  if r is null then raise exception 'вы не работаете в этом кабинете' using errcode='P0001'; end if;
  if r = 'owner' then
    raise exception 'владелец не может выйти из своего кабинета — его можно только удалить'
      using errcode='P0001';
  end if;
  delete from memberships where tenant_id = p_tenant_id and subject = p_subject;
  update app_users set active_tenant_id = null, active_mode = 'patient', mode_chosen_at = null
   where subject = p_subject and active_tenant_id = p_tenant_id;
  return jsonb_build_object('left', true);
end $$;

revoke all on function public.cabinet_scale(uuid) from public, anon, authenticated;
revoke all on function public.delete_own_cabinet(uuid,text) from public, anon, authenticated;
revoke all on function public.leave_cabinet(uuid,text) from public, anon, authenticated;
