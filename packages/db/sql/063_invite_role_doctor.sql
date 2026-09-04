-- 063_invite_role_doctor

-- Правильная роль приглашённого — 'doctor': он приходит работать.
-- Владельцем по-прежнему делает только создание кабинета.
--
-- Урок 062: значение роли надо брать из ограничения таблицы, а не
-- придумывать. memberships_role_check разрешает owner | doctor | assistant
-- | admin, и 'staff' в этот список не входит.
create or replace function public.redeem_staff_invite(p_token text, p_subject text)
returns jsonb
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare inv staff_invites%rowtype; t tenants%rowtype;
begin
  select * into inv from staff_invites where token = p_token for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'приглашение не найдено'); end if;
  if inv.used_at is not null then return jsonb_build_object('ok', false, 'reason', 'приглашение уже использовано'); end if;
  if inv.expires_at < now() then return jsonb_build_object('ok', false, 'reason', 'срок приглашения истёк'); end if;

  select * into t from tenants where id = inv.tenant_id;

  -- Приглашают работать, а не владеть.
  insert into memberships (tenant_id, subject, role)
    values (inv.tenant_id, p_subject, 'doctor')
    on conflict (tenant_id, subject) do nothing;

  update staff_invites set used_by = p_subject, used_at = now() where token = p_token;

  return jsonb_build_object('ok', true, 'tenantId', t.id, 'tenantName', t.name, 'publicToken', t.public_token);
end $$;

-- Уже выданные роли: владельцем остаётся только тот, кто кабинет создал.
update memberships m
   set role = 'doctor'
  from tenants t
 where t.id = m.tenant_id
   and m.role = 'owner'
   and exists (select 1 from memberships o
                where o.tenant_id = m.tenant_id and o.role = 'owner'
                  and o.created_at < m.created_at);

revoke all on function public.redeem_staff_invite(text,text) from public, anon, authenticated;
