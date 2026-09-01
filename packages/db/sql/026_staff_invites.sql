-- 026_staff_invites (применена 20260825181137)

-- Приглашение в кабинет вместо открытого «кто напишет startapp=doctor, тот и врач».
-- Одноразовое, с сроком жизни: на показе чужой телефон будет в приложении,
-- и постоянная ссылка на роль врача — это доступ к выручке и базе пациентов.
create table staff_invites (
  token       text primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  role        text not null default 'doctor' check (role in ('doctor','assistant','admin')),
  created_by  text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_by     text,
  used_at     timestamptz
);
create index staff_invites_tenant_idx on staff_invites (tenant_id);

alter table staff_invites enable row level security;
alter table staff_invites force row level security;
create policy staff_invites_deny_direct on staff_invites
  as restrictive for all to anon, authenticated using (false);

create or replace function create_staff_invite(
  p_tenant_id uuid, p_created_by text, p_hours int default 24
) returns text
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare tok text;
begin
  -- base64url без «+» и «/»: startapp принимает только A-Z a-z 0-9 - _
  tok := 'inv_' || replace(replace(encode(gen_random_bytes(9),'base64'),'/','_'),'+','-');
  insert into staff_invites (token, tenant_id, created_by, expires_at)
    values (tok, p_tenant_id, p_created_by, now() + make_interval(hours => p_hours));
  return tok;
end $$;

/** Гасит приглашение и заводит членство. Повторно тот же токен не сработает. */
create or replace function redeem_staff_invite(p_token text, p_subject text)
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

  insert into memberships (tenant_id, subject, role)
    values (inv.tenant_id, p_subject, 'owner')
    on conflict (tenant_id, subject) do nothing;

  update staff_invites set used_by = p_subject, used_at = now() where token = p_token;

  return jsonb_build_object('ok', true, 'tenantId', t.id, 'tenantName', t.name, 'publicToken', t.public_token);
end $$;

revoke all on function create_staff_invite(uuid,text,int) from public, anon, authenticated;
revoke all on function redeem_staff_invite(text,text) from public, anon, authenticated;;
