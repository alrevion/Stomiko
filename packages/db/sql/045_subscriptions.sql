-- 045_subscriptions (применена 20260901114219)

-- 045: подписка.
--
-- Ядро НЕ спрашивает провайдера «оплачено?». Провайдеры платежей push-овые:
-- не мы к ним ходим, а они к нам приходят и говорят «оплачено». Payme вообще
-- работает наоборот — это он вызывает наши методы. Модуль, спроектированный
-- под «спросить провайдера», сломался бы на первом же из них.
--
-- Поэтому здесь реестр, в который провайдеры ПИШУТ, а приложение читает
-- локально. На горячем пути ни одного обращения наружу: оплата не может
-- подвиснуть и уронить приём пациента.

create table subscription_plans (
  code        text primary key,
  name_ru     text not null,
  months      int  not null check (months > 0),
  price_uzs   numeric not null check (price_uzs >= 0),
  price_stars int,                 -- Telegram Stars; null = этим способом не продаётся
  is_active   boolean not null default true
);

create table subscriptions (
  tenant_id        uuid primary key references tenants(id) on delete cascade,
  plan_code        text references subscription_plans(code),
  paid_until       timestamptz not null,
  status           text not null default 'trial' check (status in ('trial','active')),
  trial_started_at timestamptz not null default now(),
  -- До какого этапа предупредили. Без этого напоминание уходило бы каждые
  -- пятнадцать минут, и врач отключил бы бота вместе с уведомлениями о записях.
  notified_stage   text,
  updated_at       timestamptz not null default now()
);

-- Заморозка НЕ хранится, а вычисляется из paid_until.
--
-- Хранимый флаг живёт своей жизнью: его выставляет задание, задание однажды
-- не отработает, и кабинет останется открытым после неоплаты либо закрытым
-- после оплаты. Вычисляемое состояние такой ошибки не допускает вовсе.

create table subscription_payments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  provider    text not null,
  external_id text not null,
  months      int  not null,
  amount      numeric,
  currency    text,
  paid_by     text,
  created_at  timestamptz not null default now(),
  -- Идемпотентность. Провайдеры повторяют вебхук при таймауте, и без этого
  -- ограничения подписка продлевалась бы дважды. Это самая частая и самая
  -- тихая ошибка в платежах.
  unique (provider, external_id)
);

do $$
declare t text;
begin
  foreach t in array array['subscription_plans','subscriptions','subscription_payments']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy %I on %I as restrictive for all to anon, authenticated using (false)',
                   t || '_deny_direct', t);
  end loop;
end $$;

-- Телефон кабинета: его показывают пациенту, когда онлайн-запись закрыта.
alter table tenants add column if not exists contact_phone text;

-- ВНИМАНИЕ: цены — заглушки, их подтверждает владелец продукта.
-- 200 000 сум взяты из ориентира «150–300 тысяч» в сценарии показа,
-- 1000 звёзд — грубый пересчёт и требует проверки в боевом счёте.
insert into subscription_plans (code, name_ru, months, price_uzs, price_stars) values
  ('monthly',  'Месяц',      1, 200000,  1000),
  ('halfyear', 'Полгода',    6, 1000000, 5000),
  ('year',     'Год',       12, 1800000, 9000);

/** Пробный период при создании кабинета. */
create or replace function public.start_trial(p_tenant_id uuid, p_days int default 14)
returns void
language sql security definer set search_path to 'public','extensions' as $$
  insert into subscriptions (tenant_id, paid_until, status)
       values (p_tenant_id, now() + make_interval(days => p_days), 'trial')
  on conflict (tenant_id) do nothing;
$$;

/**
 * Единственный вопрос, который задаёт приложение.
 *
 * Локальное чтение: ни одного обращения к провайдеру. Заморозка выводится
 * из даты, а не берётся из флага.
 */
create or replace function public.subscription_state(p_tenant_id uuid)
returns jsonb
language sql stable security definer set search_path to 'public','extensions' as $$
  select jsonb_build_object(
    'status',    s.status,
    'paidUntil', s.paid_until,
    'frozen',    s.paid_until < now(),
    'daysLeft',  greatest(0, ceil(extract(epoch from (s.paid_until - now())) / 86400))::int,
    'lastDay',   s.paid_until::date = current_date,
    'plan',      s.plan_code
  )
  from subscriptions s where s.tenant_id = p_tenant_id;
$$;

/**
 * Единственная точка, которой пользуются ВСЕ провайдеры.
 *
 * Продление считается от большего из «сейчас» и «оплачено до»: оплата за
 * месяц вперёд не должна сгорать оттого, что человек заплатил заранее.
 */
create or replace function public.credit_subscription(
  p_tenant_id uuid, p_months int, p_provider text, p_external_id text,
  p_amount numeric default null, p_currency text default null,
  p_paid_by text default null, p_plan_code text default null)
returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare already boolean; upto timestamptz;
begin
  if p_months <= 0 then raise exception 'срок должен быть больше нуля' using errcode='P0001'; end if;

  select true into already from subscription_payments
   where provider = p_provider and external_id = p_external_id;
  if already then
    -- Повтор вебхука — не ошибка. Отвечаем как на успех, но НЕ продлеваем.
    return jsonb_build_object('credited', false, 'reason', 'уже зачтён',
      'paidUntil', (select paid_until from subscriptions where tenant_id = p_tenant_id));
  end if;

  insert into subscription_payments (tenant_id, provider, external_id, months, amount, currency, paid_by)
       values (p_tenant_id, p_provider, p_external_id, p_months, p_amount, p_currency, p_paid_by);

  insert into subscriptions (tenant_id, paid_until, status, plan_code)
       values (p_tenant_id, now() + make_interval(months => p_months), 'active', p_plan_code)
  on conflict (tenant_id) do update
     set paid_until = greatest(subscriptions.paid_until, now()) + make_interval(months => p_months),
         status = 'active',
         plan_code = coalesce(p_plan_code, subscriptions.plan_code),
         notified_stage = null,
         updated_at = now()
  returning paid_until into upto;

  return jsonb_build_object('credited', true, 'paidUntil', upto);
end $$;

/** Планы для показа врачу. */
create or replace function public.subscription_plans_list()
returns table(code text, name_ru text, months int, price_uzs numeric, price_stars int)
language sql stable security definer set search_path to 'public','extensions' as $$
  select code, name_ru, months, price_uzs, price_stars
    from subscription_plans where is_active order by months;
$$;

-- Кабинет заводится сразу с пробным периодом.
create or replace function public.provision_tenant(
  p_subject text, p_name text, p_template_code text default 'therapist',
  p_doctor_name text default null)
returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare res jsonb;
begin
  res := provision_tenant_core(p_subject, p_name, p_template_code, p_doctor_name);
  perform start_trial((res->>'tenantId')::uuid, 14);
  return res || jsonb_build_object('trialDays', 14);
end $$;

create or replace function public.audit_tenant_guards()
returns table(имя text, аргументы text, причина text)
language sql stable security definer
set search_path to 'public','extensions','pg_catalog' as $$
  select p.proname::text, pg_get_function_arguments(p.oid),
         'достижима снаружи и не проверяет кабинет'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'
     and pg_get_function_arguments(p.oid) not like '%p_tenant_id%'
     and p.proname not in (
       'due_reminders', 'mark_reminded', 'redeem_staff_invite',
       'new_public_token', 'rotate_public_token', 'audit_tenant_guards',
       'touch_app_user', 'user_context', 'set_user_mode', 'my_appointments',
       'set_verified_phone', 'normalize_phone',
       'provision_tenant', 'provision_tenant_core', 'available_templates',
       'template_health', 'subscription_plans_list'
     )
     and has_function_privilege('service_role', p.oid, 'execute')
   order by p.proname;
$$;;
