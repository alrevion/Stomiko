-- 073_tour_knows_the_record

-- Шаг знакомства «Карта пациента».
--
-- Список экранов закрытый и проверяется ЗДЕСЬ, а не в приложении. Добавить
-- шаг только в TOUR на клиенте — значит получить шаг, который никогда не
-- отмечается пройденным: функция молча вернула бы прежнее состояние.
-- В этом проекте я уже трижды подставлял значение, которого нет в списке
-- допустимых, — поэтому список правится в одном коммите с интерфейсом.
--
-- Тело перенесено из 042 дословно; изменён только перечень.
create or replace function public.onboarding_seen(p_tenant_id uuid, p_screen text)
returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare cur jsonb;
begin
  if p_screen not in ('calendar','visit','stock','techcards','margin','link','record') then
    return (select onboarding from tenants where id = p_tenant_id);
  end if;
  update tenants
     set onboarding = jsonb_set(onboarding, '{seen}',
           (select jsonb_agg(distinct x) from jsonb_array_elements(
              coalesce(onboarding->'seen', '[]'::jsonb) || to_jsonb(p_screen)) x))
   where id = p_tenant_id and coalesce((onboarding->>'active')::boolean, false)
  returning onboarding into cur;
  return coalesce(cur, (select onboarding from tenants where id = p_tenant_id));
end $$;
