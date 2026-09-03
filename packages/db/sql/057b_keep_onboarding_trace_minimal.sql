-- 057b_keep_onboarding_trace_minimal

-- Тело — дословно из 042. Изменена одна строка, ради которой всё затевалось.
--
-- wipe_demo затирал `seen` при завершении знакомства. Разбирая жалобу
-- «профиль как-то не так создался», я увидел пустой список и почти сделал
-- вывод, что человек не увидел ничего. На деле список обнулило само
-- завершение, а обучение прошло штатно — понять это по состоянию базы было
-- нельзя, потому что улику стирала та же операция, о которой спрашивали.
create or replace function public.wipe_demo(p_tenant_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare v_visits int; v_patients int; v_appts int; v_batches int; kept jsonb;
begin
  delete from visit_costs where visit_id in
    (select id from visits where tenant_id = p_tenant_id and is_demo);
  delete from stock_movements where visit_id in
    (select id from visits where tenant_id = p_tenant_id and is_demo);
  delete from stock_movements where batch_id in
    (select id from batches where tenant_id = p_tenant_id and is_demo);
  delete from visit_services where visit_id in
    (select id from visits where tenant_id = p_tenant_id and is_demo);

  delete from visits where tenant_id = p_tenant_id and is_demo;
  get diagnostics v_visits = row_count;

  delete from appointment_resources where appointment_id in
    (select id from appointments where tenant_id = p_tenant_id and is_demo);
  delete from appointments where tenant_id = p_tenant_id and is_demo;
  get diagnostics v_appts = row_count;

  delete from batches where tenant_id = p_tenant_id and is_demo;
  get diagnostics v_batches = row_count;

  delete from patients p where p.tenant_id = p_tenant_id and p.is_demo
    and not exists (select 1 from visits v where v.patient_id = p.id)
    and not exists (select 1 from appointments a where a.patient_id = p.id);
  get diagnostics v_patients = row_count;

  -- Единственное отличие от 042: список пройденного не затирается. Читать
  -- его в работе некому — active уже false, — а при разборе он отвечает на
  -- вопрос «а он вообще смотрел».
  select coalesce(onboarding->'seen', '[]'::jsonb) into kept
    from tenants where id = p_tenant_id;

  update tenants
     set onboarding = jsonb_build_object('active', false, 'seen', kept,
                                         'finishedAt', to_jsonb(now()))
   where id = p_tenant_id;

  return jsonb_build_object('visits', v_visits, 'appointments', v_appts,
                            'patients', v_patients, 'batches', v_batches);
end $$;

revoke all on function public.wipe_demo(uuid) from public, anon, authenticated;
