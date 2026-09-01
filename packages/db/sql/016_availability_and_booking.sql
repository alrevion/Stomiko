-- 016_availability_and_booking (применена 20260825102413)

-- Доступность по модели «правило + исключения» (как у Cal.com и всех зрелых
-- систем записи): повторяющиеся недельные часы плюс разовые правки на дату.
-- Отдельное расписание под каждую нестандартную неделю не заводится.

-- Повторяющиеся рабочие часы. Несколько строк на один день недели дают перерыв:
-- 09:00–13:00 и 14:00–18:00 — это две строки, а не одна с дыркой.
create table working_hours (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  resource_id uuid not null references resources(id) on delete cascade,
  -- 0 = воскресенье, как в JS getDay(). У кого-то выходные сб-вс, у кого-то пн-вт.
  weekday     int  not null check (weekday between 0 and 6),
  starts_at   time not null,
  ends_at     time not null,
  check (ends_at > starts_at)
);
create index working_hours_lookup on working_hours (tenant_id, resource_id, weekday);

-- Разовая правка на конкретную дату: закрыть день целиком либо открыть
-- с другими часами. Отпуск, праздник, «в эту субботу работаю».
create table schedule_overrides (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  resource_id uuid not null references resources(id) on delete cascade,
  on_date     date not null,
  is_closed   boolean not null default true,
  starts_at   time,
  ends_at     time,
  reason      text,
  check (is_closed or (starts_at is not null and ends_at is not null and ends_at > starts_at))
);
create index schedule_overrides_lookup on schedule_overrides (tenant_id, resource_id, on_date);

create table booking_settings (
  tenant_id          uuid primary key references tenants(id) on delete cascade,
  -- Шаг сетки слотов. 15 минут — компромисс между гибкостью и длиной списка.
  slot_step_minutes  int not null default 15 check (slot_step_minutes between 5 and 60),
  -- Минимальный запас: нельзя записаться «через пять минут».
  min_notice_minutes int not null default 120 check (min_notice_minutes >= 0),
  -- Горизонт записи вперёд.
  max_days_ahead     int not null default 30 check (max_days_ahead between 1 and 365),
  -- Зазор после приёма: убрать, продезинфицировать, записать.
  buffer_minutes     int not null default 10 check (buffer_minutes >= 0)
);

-- Длительность приёма зависит от услуги: осмотр — 20 минут, эндодонтия — час.
alter table services add column duration_minutes int not null default 30
  check (duration_minutes between 5 and 480);
-- Услуги, которые пациент не может выбрать сам при онлайн-записи.
alter table services add column bookable boolean not null default true;

-- Откуда пришла запись: из кабинета или пациент записался сам.
alter table appointments add column source text not null default 'staff'
  check (source in ('staff','patient_link','walk_in'));
alter table appointments add column service_id uuid references services(id) on delete set null;
alter table appointments add column note text;

-- Телефон пациента — единственное, что нужно для связи. Уникален в рамках
-- кабинета: повторная запись того же человека не плодит карточки.
create unique index patients_phone_uq on patients (tenant_id, phone) where phone is not null;;
