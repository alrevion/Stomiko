-- 036_verified_phone (применена 20260901111101)

-- 036: телефон приходит от Telegram, а не из формы.
--
-- Раньше номер вводили руками, и один человек легко заводил две карточки:
-- «+998 90 123-45-67» и «998901234567» — для базы это разные строки. Врач
-- звонил по опечатке и не дозванивался, а история лечения расползалась по
-- двум карточкам.
--
-- Подделать подтверждённый номер нельзя: его присылает сам Telegram
-- в служебном сообщении боту, а не браузер пациента.

/** Единый вид номера. Всё, что не цифра, выбрасывается. */
create or replace function public.normalize_phone(p text)
returns text language sql immutable as $$
  select case when p is null or regexp_replace(p, '\D', '', 'g') = '' then null
              else '+' || regexp_replace(p, '\D', '', 'g') end;
$$;

/**
 * Сохранить подтверждённый номер и подтянуть к нему карточки.
 *
 * Карточка, заведённая врачом с этим номером, но ещё ни к кому не привязанная,
 * связывается с аккаунтом: человек сразу видит свою историю, а повторная
 * запись не плодит второй карточки. Чужие карточки не трогаем — уже
 * привязанную не перехватить.
 */
create or replace function public.set_verified_phone(p_subject text, p_phone text)
returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare norm text; linked int;
begin
  norm := public.normalize_phone(p_phone);
  if norm is null or length(norm) < 9 then
    raise exception 'номер не распознан' using errcode='P0001';
  end if;

  insert into app_users (subject, phone, phone_verified_at)
       values (p_subject, norm, now())
  on conflict (subject) do update
     set phone = norm, phone_verified_at = now();

  update patients set telegram_subject = p_subject
   where phone = norm and telegram_subject is null;
  get diagnostics linked = row_count;

  return jsonb_build_object('phone', norm, 'linkedCards', linked);
end $$;

/**
 * Запись с подтверждённым номером.
 *
 * Карточка ищется сперва по аккаунту Telegram, и только потом по номеру:
 * если врач поправил телефон в карточке, человек всё равно должен попасть
 * в СВОЮ историю, а не завести вторую.
 */
create or replace function public.book_appointment(
  p_tenant_id uuid, p_resource_id uuid, p_service_id uuid,
  p_starts_at timestamptz, p_patient_name text, p_phone text,
  p_note text default null, p_source text default 'patient_link',
  p_subject text default null)
returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare
  duration int; ends timestamptz; pid uuid; aid uuid; loc uuid; norm text;
begin
  select duration_minutes into duration from services
   where id = p_service_id and tenant_id = p_tenant_id;
  if duration is null then raise exception 'услуга не найдена' using errcode='P0002'; end if;
  ends := p_starts_at + make_interval(mins => duration);
  norm := public.normalize_phone(p_phone);

  select id into loc from locations where tenant_id = p_tenant_id limit 1;

  if p_subject is not null then
    select id into pid from patients
     where tenant_id = p_tenant_id and telegram_subject = p_subject limit 1;
  end if;
  if pid is null and norm is not null then
    select id into pid from patients
     where tenant_id = p_tenant_id and public.normalize_phone(phone) = norm limit 1;
  end if;

  if pid is null then
    insert into patients (tenant_id, full_name, phone, telegram_subject)
      values (p_tenant_id, coalesce(nullif(trim(p_patient_name),''), 'Пациент'), norm, p_subject)
      returning id into pid;
  else
    -- Карточка нашлась: дописываем то, чего в ней не было.
    update patients
       set telegram_subject = coalesce(telegram_subject, p_subject),
           phone = coalesce(public.normalize_phone(phone), norm),
           full_name = case when full_name in ('Пациент','Пациент без имени')
                            then coalesce(nullif(trim(p_patient_name),''), full_name)
                            else full_name end
     where id = pid;
  end if;

  insert into appointments (tenant_id, patient_id, starts_at, ends_at, source, service_id, note)
    values (p_tenant_id, pid, p_starts_at, ends, p_source, p_service_id, p_note)
    returning id into aid;

  -- Защита от двойной записи: пересечение по креслу отвергается ограничением,
  -- вся транзакция откатывается.
  insert into appointment_resources (tenant_id, appointment_id, resource_id, role, starts_at, ends_at)
    values (p_tenant_id, aid, p_resource_id, 'chair', p_starts_at, ends);

  return jsonb_build_object(
    'appointmentId', aid, 'patientId', pid,
    'startsAt', p_starts_at, 'endsAt', ends, 'locationId', loc
  );
exception when exclusion_violation then
  raise exception 'слот уже занят' using errcode='23P01';
end $$;

-- Старая восьмиаргументная версия больше не нужна: у неё не было subject,
-- и карточки связывались только по номеру.
drop function if exists public.book_appointment(uuid, uuid, uuid, timestamptz, text, text, text, text);

-- Ключ — subject из подписанного initData, тенанта у неё нет намеренно.
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
       'set_verified_phone',   -- ключ subject из подписанного initData
       'normalize_phone'       -- чистая функция над строкой, ничего не читает
     )
     and has_function_privilege('service_role', p.oid, 'execute')
   order by p.proname;
$$;;
