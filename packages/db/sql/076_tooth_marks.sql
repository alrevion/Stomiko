-- 076_tooth_marks

-- Состояние зубов: кариес, пломба, коронка и всё остальное, что врач видит
-- во рту и должен где-то отметить.
--
-- Отличие от клинической записи принципиальное. Клиническая запись говорит
-- «12 марта поставили пломбу на 26» — это факт в прошлом, он запечатан и не
-- меняется. Отметка говорит «на 26 сейчас пломба» — это СОСТОЯНИЕ, и оно
-- меняется: был кариес, стала пломба, потом коронка. Одно из другого не
-- выводится: по услуге «пломба» не понять, жива ли она через два года, а по
-- отметке не понять, кто и когда её ставил. Нужны обе.
--
-- Отметки не удаляются и не переписываются. Новая отметка той же категории
-- на том же зубе ВЫТЕСНЯЕТ прежнюю, а прежняя остаётся историей: врач должен
-- видеть, что на 26 сначала был кариес, потом пломба, а не только последнее.

-- ── Справочник отметок ──────────────────────────────────────────────────────
--
-- Таблицей, а не перечислением в коде: цвет и название нужны интерфейсу, и
-- держать их в двух местах значит однажды перекрасить кариес только в одном.
create table if not exists mark_codes (
  code        text primary key,
  category    text not null,
  name_ru     text not null,
  color       text not null check (color ~ '^#[0-9a-f]{6}$'),
  position    int  not null
);

comment on table mark_codes is
  'Палитра отметок зубной карты. Категория — то, что может быть у зуба одновременно.';

insert into mark_codes (code, category, name_ru, color, position) values
  -- Состояние зуба: сам зуб как таковой
  ('missing',            'state',  'Отсутствует',                  '#6b7280', 10),
  ('root_rest',          'state',  'Остаток корня',                '#8d6e63', 20),
  ('to_extract',         'state',  'Под удаление',                 '#ef4444', 30),
  -- Поражения: что с твёрдыми тканями
  ('discolored',         'lesion', 'Изменён в цвете',              '#8f8f0f', 10),
  ('caries_early',       'lesion', 'Начальный кариес',             '#f5b301', 20),
  ('caries',             'lesion', 'Кариес',                       '#ef4444', 30),
  ('caries_cervical',    'lesion', 'Пришеечный кариес',            '#db2777', 40),
  ('wedge',              'lesion', 'Клиновидный дефект',           '#8d6e63', 50),
  ('needs_care',         'lesion', 'Требует лечения',              '#22a34a', 60),
  -- Пародонт: что с тем, что держит зуб
  ('perio_ok',           'perio',  'Пародонт здоров',              '#5aa363', 10),
  ('periodontitis',      'perio',  'Пародонтит',                   '#6d28d9', 20),
  ('gingivitis',         'perio',  'Гингивит',                     '#e8547f', 30),
  ('calculus',           'perio',  'Зубной камень',                '#5d4037', 40),
  -- Эндодонтия: что с каналами
  ('pulpitis',           'endo',   'Пульпит',                      '#f59e0b', 10),
  ('depulped',           'endo',   'Депульпирован',                '#12786a', 20),
  ('canal_none',         'endo',   'Канал не запломбирован',       '#ea6a0a', 30),
  ('canal_part',         'endo',   'Канал запломбирован частично', '#f0b429', 40),
  ('canal_full',         'endo',   'Канал запломбирован',          '#0f6b5f', 50),
  ('apical',             'endo',   'Периодонтит (апикальный)',     '#b91c1c', 60),
  -- Конструкции: что на зубе стоит
  ('filling',            'build',  'Пломба',                       '#3b82f6', 10),
  ('filling_cervical',   'build',  'Пришеечная пломба',            '#1e3a8a', 20),
  ('veneer',             'build',  'Винир',                        '#4bb8cc', 30),
  ('crown_temp',         'build',  'Временная коронка',            '#94a3b8', 40),
  ('crown_ceramic',      'build',  'Коронка керамическая',         '#a8b5c2', 50),
  ('crown_metal_cer',    'build',  'Коронка металлокерамическая',  '#8595a5', 60),
  ('crown_metal',        'build',  'Коронка металлическая',        '#9ca3af', 70),
  ('crown_zircon',       'build',  'Коронка циркониевая',          '#b9c5d0', 80),
  ('post',               'build',  'Штифт',                        '#5b3a29', 90),
  ('core_inlay',         'build',  'Культевая вкладка',            '#6b4331', 100),
  ('abutment',           'build',  'Абатмент',                     '#7f8fa0', 110),
  ('gum_former',         'build',  'Формирователь десны',          '#b08a7e', 120),
  ('implant',            'build',  'Имплант',                      '#7c3aed', 130)
on conflict (code) do update
  set category = excluded.category, name_ru = excluded.name_ru,
      color = excluded.color, position = excluded.position;

-- ── Отметки ────────────────────────────────────────────────────────────────
--
-- Кому принадлежит отметка, решает наличие Telegram у пациента, и это же
-- решают внешние ключи. Есть аккаунт — отметка человека: `person_subject`
-- заполнен, `patient_id` пуст, удаление кабинета её не трогает и обнуляет
-- только автора. Нет аккаунта — отметка кабинета: живёт по `patient_id` и
-- уходит вместе с кабинетом, потому что человека, которому её отдать, в
-- системе нет.
create table if not exists tooth_marks (
  id              uuid primary key default gen_random_uuid(),
  person_subject  text references app_users(subject) on delete cascade,
  patient_id      uuid references patients(id) on delete cascade,
  tenant_id       uuid references tenants(id) on delete set null,
  author_cabinet  text not null,
  author_doctor   text,
  tooth           text not null check (tooth ~ '^[1-8][1-8]$'),
  category        text not null,
  -- Пусто значит «отметку сняли»: строка остаётся, чтобы в истории было
  -- видно и когда поставили, и когда сняли.
  code            text references mark_codes(code),
  note            text,
  noted_on        date not null default (now() at time zone 'Asia/Tashkent')::date,
  created_at      timestamptz not null default now(),
  check (person_subject is not null or patient_id is not null)
);

create index if not exists tooth_marks_person on tooth_marks (person_subject, tooth, category, created_at desc);
create index if not exists tooth_marks_patient on tooth_marks (patient_id, tooth, category, created_at desc);

alter table tooth_marks enable row level security;
drop policy if exists tooth_marks_no_anon on tooth_marks;
create policy tooth_marks_no_anon on tooth_marks for all to anon using (false) with check (false);
drop policy if exists tooth_marks_no_auth on tooth_marks;
create policy tooth_marks_no_auth on tooth_marks for all to authenticated using (false) with check (false);

-- Журнал должен знать новое действие. Значение из списка допустимых берут ИЗ
-- ограничения, а не из головы: в этом проекте я на этом спотыкался трижды,
-- и один раз журнал молча ничего не писал целую неделю.
alter table access_log drop constraint if exists access_log_action_check;
alter table access_log add constraint access_log_action_check
  check (action in ('patient_card','patient_search','visit','patient_edit',
                    'staff_joined','clinical_record','clinical_amend','tooth_mark'));

/** Палитра для интерфейса. Порядок — клинический, а не алфавитный. */
create or replace function public.mark_palette()
returns jsonb
language sql stable security definer set search_path to 'public','extensions' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'code', code, 'category', category, 'name', name_ru, 'color', color)
           order by category, position), '[]'::jsonb)
    from mark_codes;
$$;

/**
 * Текущее состояние зубов из отметок.
 *
 * Текущее — это ПОСЛЕДНЯЯ отметка каждой категории на каждом зубе. Снятая
 * отметка (пустой код) тоже последняя, и тогда у зуба этой категории нет.
 */
create or replace function public.tooth_chart_of(p_subject text, p_patient_id uuid)
returns jsonb
language sql stable security definer set search_path to 'public','extensions' as $$
  with last as (
    select distinct on (m.tooth, m.category)
           m.tooth, m.category, m.code, m.note, m.noted_on,
           m.author_cabinet, m.author_doctor
      from tooth_marks m
     where (p_subject is not null and m.person_subject = p_subject)
        or (p_patient_id is not null and m.patient_id = p_patient_id)
     order by m.tooth, m.category, m.created_at desc
  )
  select jsonb_build_object(
    'marks', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tooth', l.tooth, 'category', l.category, 'code', l.code,
               'name', c.name_ru, 'color', c.color, 'note', l.note,
               'notedOn', l.noted_on, 'cabinet', l.author_cabinet, 'doctor', l.author_doctor)
               order by l.tooth, c.position)
        from last l join mark_codes c on c.code = l.code
       where l.code is not null), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tooth', m.tooth, 'category', m.category, 'code', m.code,
               'name', c.name_ru, 'color', c.color, 'notedOn', m.noted_on,
               'cabinet', m.author_cabinet, 'doctor', m.author_doctor)
               order by m.created_at desc)
        from tooth_marks m left join mark_codes c on c.code = m.code
       where (p_subject is not null and m.person_subject = p_subject)
          or (p_patient_id is not null and m.patient_id = p_patient_id)), '[]'::jsonb));
$$;

/** Своя зубная карта. Ключ — подписанный subject, как и у истории. */
create or replace function public.my_tooth_chart(p_subject text)
returns jsonb
language sql stable security definer set search_path to 'public','extensions' as $$
  select public.tooth_chart_of(p_subject, null);
$$;

/**
 * Зубная карта пациента у врача.
 *
 * Если пациент связан с человеком — отдаём карту ЧЕЛОВЕКА, со всеми
 * кабинетами: в этом весь смысл переносимой карты. Право то же, что у
 * истории лечения, и проверяется той же функцией.
 */
create or replace function public.patient_tooth_chart(
  p_tenant_id uuid, p_patient_id uuid, p_actor text)
returns jsonb
language plpgsql stable security definer set search_path to 'public','extensions' as $$
declare subj text;
begin
  select p.telegram_subject into subj
    from patients p where p.id = p_patient_id and p.tenant_id = p_tenant_id;
  if not found then raise exception 'пациент не найден' using errcode='P0002'; end if;

  if subj is not null and not public.doctor_may_see_person(p_tenant_id, subj) then
    raise exception 'карта открыта, только пока пациент записан или приём не закрыт'
      using errcode='P0001';
  end if;
  return public.tooth_chart_of(subj, case when subj is null then p_patient_id end);
end $$;

/**
 * Поставить или снять отметку.
 *
 * Ставится ДОБАВЛЕНИЕМ: прежняя отметка той же категории не переписывается,
 * а вытесняется по времени. Иначе «был кариес — стала пломба» превратилось бы
 * в «всегда была пломба», и спорить о качестве лечения стало бы не с чем.
 */
create or replace function public.set_tooth_mark(
  p_tenant_id uuid, p_patient_id uuid, p_tooth text,
  p_code text, p_note text, p_actor text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions' as $$
declare subj text; cat text; cab text; doc text; v_code text; nid uuid;
begin
  if p_tooth !~ '^[1-8][1-8]$' then
    raise exception '«%» — не номер зуба по FDI. Например 26.', p_tooth using errcode='P0001';
  end if;
  v_code := nullif(trim(coalesce(p_code, '')), '');
  if v_code is null then
    raise exception 'не указана отметка' using errcode='P0001';
  end if;
  select category into cat from mark_codes where code = v_code;
  if cat is null then
    raise exception 'неизвестная отметка «%»', v_code using errcode='P0001';
  end if;

  select p.telegram_subject into subj
    from patients p where p.id = p_patient_id and p.tenant_id = p_tenant_id;
  if not found then raise exception 'пациент не найден' using errcode='P0002'; end if;

  if subj is not null and not public.doctor_may_see_person(p_tenant_id, subj) then
    raise exception 'отмечать можно, только пока пациент записан или приём не закрыт'
      using errcode='P0001';
  end if;

  select t.name into cab from tenants t where t.id = p_tenant_id;
  select r.name into doc from resources r
   where r.tenant_id = p_tenant_id and r.kind = 'practitioner'
     and r.name not in ('Врач','Доктор','') limit 1;

  insert into tooth_marks (
    person_subject, patient_id, tenant_id, author_cabinet, author_doctor,
    tooth, category, code, note)
  values (subj, case when subj is null then p_patient_id end, p_tenant_id, cab, doc,
          p_tooth, cat, v_code, nullif(trim(coalesce(p_note, '')), ''))
  returning id into nid;

  perform public.log_access(p_tenant_id, p_actor, 'tooth_mark', p_patient_id,
                            p_tooth || ' ' || v_code);
  return jsonb_build_object('id', nid, 'tooth', p_tooth, 'category', cat, 'code', v_code);
end $$;

/** Снять отметку категории с зуба. Строка остаётся — снятие тоже история. */
create or replace function public.clear_tooth_mark(
  p_tenant_id uuid, p_patient_id uuid, p_tooth text, p_category text, p_actor text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions' as $$
declare subj text; cab text; doc text;
begin
  if not exists (select 1 from mark_codes where category = p_category) then
    raise exception 'неизвестная группа отметок «%»', p_category using errcode='P0001';
  end if;
  select p.telegram_subject into subj
    from patients p where p.id = p_patient_id and p.tenant_id = p_tenant_id;
  if not found then raise exception 'пациент не найден' using errcode='P0002'; end if;
  if subj is not null and not public.doctor_may_see_person(p_tenant_id, subj) then
    raise exception 'отмечать можно, только пока пациент записан или приём не закрыт'
      using errcode='P0001';
  end if;

  select t.name into cab from tenants t where t.id = p_tenant_id;
  select r.name into doc from resources r
   where r.tenant_id = p_tenant_id and r.kind = 'practitioner'
     and r.name not in ('Врач','Доктор','') limit 1;

  insert into tooth_marks (
    person_subject, patient_id, tenant_id, author_cabinet, author_doctor,
    tooth, category, code)
  values (subj, case when subj is null then p_patient_id end, p_tenant_id, cab, doc,
          p_tooth, p_category, null);

  perform public.log_access(p_tenant_id, p_actor, 'tooth_mark', p_patient_id,
                            p_tooth || ' снято ' || p_category);
  return jsonb_build_object('tooth', p_tooth, 'category', p_category, 'code', null);
end $$;

revoke all on function public.mark_palette() from public, anon, authenticated;
revoke all on function public.tooth_chart_of(text,uuid) from public, anon, authenticated;
revoke all on function public.my_tooth_chart(text) from public, anon, authenticated;
revoke all on function public.patient_tooth_chart(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.set_tooth_mark(uuid,uuid,text,text,text,text) from public, anon, authenticated;
revoke all on function public.clear_tooth_mark(uuid,uuid,text,text,text) from public, anon, authenticated;

-- Сторож должен знать о новых функциях без тенанта, иначе он честно объявит
-- их дырой. Три из них дыры не образуют: палитра — общий справочник, а обе
-- карты ключуются подписанным subject, который подделать нельзя.
-- Тело из 071 дословно; добавлены три имени.
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
       'confirm_appointment', 'my_treatment_plans',
       'material_unit_price', 'tg_close_plan_items', 'tg_seal_clinical_entries',
       'public_cabinets', 'public_cities',
       'person_cards', 'person_summary', 'my_clinical_record',
       'backfill_clinical_history', 'clinical_health', 'clinical_log_health',
       'mark_palette', 'tooth_chart_of', 'my_tooth_chart',
       'set_verified_phone', 'normalize_phone',
       'provision_tenant', 'provision_tenant_core', 'available_templates',
       'template_health', 'subscription_plans_list', 'due_subscription_notices',
       'rls_health', 'prune_access_log'
     )
     and has_function_privilege('service_role', p.oid, 'execute')
   order by p.proname;
$$;
