-- 064_person_links_cards
--
-- Шаг 1: человек становится сущностью, а карточка в кабинете — связью.
--
-- Отдельной таблицы `persons` НЕ завожу, хотя спека её предполагала.
-- Человек на платформе уже есть — это app_users: подписанный subject из
-- Telegram, имя, подтверждённый телефон. Заводить рядом вторую сущность с
-- тем же ключом значит завести два источника правды о том, кто это, и
-- однажды они разойдутся.
--
-- Связь тоже уже была — patients.telegram_subject, — но держалась на
-- договорённости: колонка text без внешнего ключа. Строка могла указывать
-- на несуществующий аккаунт, и никто бы не заметил. Теперь это настоящая
-- ссылка: карта не может принадлежать человеку, которого нет.
alter table patients
  add constraint patients_person_fk
  foreign key (telegram_subject) references app_users(subject)
  on delete set null;

create index if not exists patients_person_idx
  on patients (telegram_subject) where telegram_subject is not null;

/**
 * Карточки человека по всем кабинетам.
 *
 * Основание будущей переносимой истории: пока это просто «где он лечится»,
 * дальше сюда встанут клинические записи.
 */
create or replace function public.person_cards(p_subject text)
returns table (patient_id uuid, tenant_id uuid, cabinet text,
               full_name text, visits bigint, last_visit date)
language sql stable security definer set search_path to 'public','extensions' as $$
  select p.id, p.tenant_id, t.name, p.full_name,
         (select count(*) from visits v where v.patient_id = p.id and v.status = 'closed'),
         (select max(v.visit_date) from visits v where v.patient_id = p.id and v.status = 'closed')
    from patients p
    join tenants t on t.id = p.tenant_id
   where p.telegram_subject = p_subject
   order by 6 desc nulls last, t.name;
$$;

/**
 * Сколько кабинетов знают этого человека.
 *
 * Нужно интерфейсу, чтобы честно сказать: история носится с собой только у
 * того, у кого подтверждён Telegram. У остальных карта остаётся в кабинете.
 */
create or replace function public.person_summary(p_subject text)
returns jsonb
language sql stable security definer set search_path to 'public','extensions' as $$
  select jsonb_build_object(
    'subject', u.subject,
    'name', u.first_name,
    'phoneVerified', u.phone_verified_at is not null,
    'cabinets', (select count(*) from patients p where p.telegram_subject = u.subject),
    'visits', (select count(*) from visits v
                join patients p on p.id = v.patient_id
               where p.telegram_subject = u.subject and v.status = 'closed'))
    from app_users u where u.subject = p_subject;
$$;

revoke all on function public.person_cards(text) from public, anon, authenticated;
revoke all on function public.person_summary(text) from public, anon, authenticated;
