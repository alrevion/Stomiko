-- 069_record_access_is_logged (применена 20260904134024)

-- 069_record_access_is_logged
--
-- person_record_for_doctor была объявлена stable, а внутри пишет в журнал
-- доступа. Postgres запрещает запись из нестабильной функции, log_access
-- глотает свои ошибки предупреждением — и обращения к медицинской истории
-- НЕ ЗАПИСЫВАЛИСЬ. Молча.
--
-- Это худший вид поломки для журнала: он выглядит работающим ровно до дня,
-- когда по нему надо будет ответить, кто и когда смотрел карту. Функция,
-- которая пишет, обязана быть volatile — читать её сигнатуру и есть способ
-- это заметить.
create or replace function public.person_record_for_doctor(
  p_tenant_id uuid, p_subject text, p_actor text
) returns jsonb
language plpgsql volatile security definer set search_path to 'public','extensions' as $$
declare r jsonb;
begin
  if not public.doctor_may_see_person(p_tenant_id, p_subject) then
    raise exception 'история открыта только пока пациент записан или приём не закрыт'
      using errcode='P0001';
  end if;
  perform public.log_access(p_tenant_id, p_actor, 'clinical_record', null, p_subject);
  select public.my_clinical_record(p_subject) into r;
  return r;
end $$;

revoke all on function public.person_record_for_doctor(uuid,text,text)
  from public, anon, authenticated;

/**
 * Сторож журнала.
 *
 * Проверяет не наличие кода, а факт: за последние сутки обращения к
 * медицинским историям оставили следы. Молчащий журнал — это журнал,
 * которого нет.
 */
create or replace function public.clinical_log_health()
returns jsonb
language sql stable security definer set search_path to 'public','extensions' as $$
  select jsonb_build_object(
    'reads_24h',  (select count(*) from access_log
                    where action = 'clinical_record' and at > now() - interval '1 day'),
    'amends_24h', (select count(*) from access_log
                    where action = 'clinical_amend' and at > now() - interval '1 day'));
$$;

revoke all on function public.clinical_log_health() from public, anon, authenticated;;
