-- 025_reminders (применена 20260825180622)

-- Напоминания. Без них онлайн-запись не отличается от записи в тетрадь:
-- пациент забывает, врач теряет окно. Отметки хранятся на записи, а не в
-- отдельной очереди — так повторная отправка невозможна по построению.
alter table appointments add column reminded_day_at  timestamptz;
alter table appointments add column reminded_hour_at timestamptz;

/**
 * Что нужно напомнить прямо сейчас.
 *
 * kind = 'day'  — накануне, примерно за сутки;
 * kind = 'hour' — за пару часов, когда уже пора выезжать.
 *
 * Окно намеренно широкое (±30 минут от цели): планировщик может опоздать,
 * а пропущенное напоминание хуже, чем присланное на полчаса раньше.
 */
create or replace function due_reminders(p_now timestamptz default now())
returns table (
  appointment_id uuid, kind text, tenant_id uuid, cabinet text,
  telegram_subject text, patient_name text, patient_phone text,
  service_name text, starts_at timestamptz
)
language sql stable security definer set search_path = public, extensions
as $$
  select a.id, 'day', a.tenant_id, t.name, p.telegram_subject, p.full_name, p.phone,
         s.name_ru, a.starts_at
    from appointments a
    join tenants t on t.id = a.tenant_id
    join patients p on p.id = a.patient_id
    left join services s on s.id = a.service_id
   where a.status = 'scheduled'
     and a.reminded_day_at is null
     and p.telegram_subject is not null
     and a.starts_at between p_now + interval '23 hours' and p_now + interval '25 hours'
  union all
  select a.id, 'hour', a.tenant_id, t.name, p.telegram_subject, p.full_name, p.phone,
         s.name_ru, a.starts_at
    from appointments a
    join tenants t on t.id = a.tenant_id
    join patients p on p.id = a.patient_id
    left join services s on s.id = a.service_id
   where a.status = 'scheduled'
     and a.reminded_hour_at is null
     and p.telegram_subject is not null
     and a.starts_at between p_now + interval '90 minutes' and p_now + interval '150 minutes';
$$;

create or replace function mark_reminded(p_appointment_id uuid, p_kind text)
returns void
language sql volatile security definer set search_path = public, extensions
as $$
  update appointments
     set reminded_day_at  = case when p_kind = 'day'  then now() else reminded_day_at  end,
         reminded_hour_at = case when p_kind = 'hour' then now() else reminded_hour_at end
   where id = p_appointment_id;
$$;

/** Кому из кабинета писать о новой записи и отмене. */
create or replace function tenant_staff(p_tenant_id uuid)
returns table (subject text, role text)
language sql stable security definer set search_path = public, extensions
as $$
  select m.subject, m.role from memberships m where m.tenant_id = p_tenant_id;
$$;

revoke all on function due_reminders(timestamptz) from public, anon, authenticated;
revoke all on function mark_reminded(uuid, text) from public, anon, authenticated;
revoke all on function tenant_staff(uuid) from public, anon, authenticated;;
