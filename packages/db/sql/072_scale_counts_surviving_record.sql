-- 072_scale_counts_surviving_record

-- Окно удаления кабинета обещало неправду.
--
-- До 065 карты пациентов жили только в кабинете, и текст «медицинские карты
-- исчезнут вместе с кабинетом» был верен. Теперь клиническая запись
-- принадлежит человеку и удаление кабинета её не трогает — обнуляется только
-- ссылка на автора. Текст остался прежним и пугал врача тем, чего не будет.
--
-- Считаем то, что ПЕРЕЖИВЁТ удаление, тем же запросом, что и то, что
-- исчезнет: обещание с числом проверяемо, обещание словами — нет.
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
    'staff',       (select count(*) from memberships  where tenant_id = p_tenant_id),
    -- Записи, которые вы внесли в истории пациентов. Останутся у них.
    'records',     (select count(*) from clinical_entries where author_tenant_id = p_tenant_id));
$$;

revoke all on function public.cabinet_scale(uuid) from public, anon, authenticated;
