-- 070_log_new_actions_and_stop_swallowing (применена 20260904134137)

-- 070_log_new_actions_and_stop_swallowing
--
-- access_log.action — закрытый список, и моих двух значений в нём не было.
-- Вставка падала на проверке, log_access глотала ошибку предупреждением, и
-- обращения к медицинской истории НЕ ЗАПИСЫВАЛИСЬ. Молча.
--
-- Это третий раз за сессию, когда я подставил значение, которого нет в
-- списке допустимых: сначала роль 'staff', теперь действия журнала. Общее
-- правило: значение колонки со списком берут ИЗ ограничения, а не из головы.
alter table access_log drop constraint access_log_action_check;
alter table access_log add constraint access_log_action_check
  check (action = any (array[
    'patient_card', 'patient_search', 'visit', 'patient_edit', 'staff_joined',
    'clinical_record', 'clinical_amend']));

/**
 * Запись в журнал доступа.
 *
 * Раньше глотала ЛЮБУЮ ошибку. Замысел был верный — сбой журнала не должен
 * останавливать приём пациента, — но он же спрятал поломку: незарегистрированное
 * действие тихо не писалось, и журнал выглядел работающим ровно до дня,
 * когда по нему надо было бы ответить, кто смотрел карту.
 *
 * Теперь различаем. Нарушение проверки — это ошибка кода: действие забыли
 * внести в список, и молчать об этом нельзя. Остальное — по-прежнему
 * предупреждение: недоступность журнала не повод не лечить.
 */
create or replace function public.log_access(
  p_tenant_id uuid, p_subject text, p_action text,
  p_target_id uuid default null, p_detail text default null)
returns void
language plpgsql security definer set search_path to 'public','extensions' as $$
begin
  insert into access_log (tenant_id, subject, action, target_id, detail)
       values (p_tenant_id, p_subject, p_action, p_target_id, left(p_detail, 200));
exception
  when check_violation then
    raise exception 'действие «%» не внесено в список журнала доступа', p_action
      using errcode = 'P0001';
  when others then
    raise warning 'журнал доступа: %', sqlerrm;
end $$;

revoke all on function public.log_access(uuid,text,text,uuid,text)
  from public, anon, authenticated;;
