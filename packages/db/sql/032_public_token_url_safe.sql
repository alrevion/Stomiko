-- 032_public_token_url_safe (применена 20260901105348)

-- 032: ссылка кабинета, которая не сломается и которую не подберут.
--
-- Было: 'd_' || replace(encode(gen_random_bytes(6),'base64'), '/', '_').
-- Две беды в одной строке:
--   1. base64 выдаёт ещё и '+', а Telegram в startapp допускает только
--      [A-Za-z0-9_-]. Первому же кабинету, которому выпал бы '+', ссылка не
--      открылась бы вообще — и понять почему было бы нечем.
--   2. Шесть байт — 48 бит. Для идентификатора, который ходит по перепискам
--      и визиткам, мало.
--
-- Стало: 24 байта (192 бита) в base64url. '=' не появляется: 24 кратно трём.

create or replace function public.new_public_token()
returns text language sql volatile as $$
  select 'd_' || translate(encode(gen_random_bytes(24), 'base64'), '+/=', '-_');
$$;

alter table tenants alter column public_token set default public.new_public_token();

-- Формат проверяет база, а не намерение автора. Ограничение только на алфавит:
-- существующий короткий токен действующего кабинета остаётся рабочим, ломать
-- уже разосланную ссылку из-за длины неправильно.
alter table tenants drop constraint if exists tenants_public_token_format;
alter table tenants add constraint tenants_public_token_format
  check (public_token ~ '^d_[A-Za-z0-9_-]{8,}$');

-- Смена токена, когда ссылка утекла или разошлась не туда.
create or replace function public.rotate_public_token(p_tenant_id uuid)
returns text language plpgsql security definer
set search_path to 'public','extensions' as $$
declare t text;
begin
  update tenants set public_token = public.new_public_token()
   where id = p_tenant_id returning public_token into t;
  if t is null then raise exception 'кабинет не найден' using errcode='P0002'; end if;
  return t;
end $$;

comment on function public.new_public_token() is
  '192 бита в base64url. Алфавит совпадает с тем, что Telegram допускает в startapp.';;
