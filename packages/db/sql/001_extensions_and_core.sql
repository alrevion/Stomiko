-- Stomiko 001: расширения, организация, филиалы, доступ.
-- Источник истины по схеме — эти файлы, а не ORM: EXCLUDE, RLS и plpgsql в Drizzle невыразимы.

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

-- Организация, а не кабинет: кабинет на 1 кресло и сеть филиалов должны жить
-- в одной модели, иначе переход кабинет → клиника = ломающая миграция.
create table tenants (
  id           uuid primary key default gen_random_uuid(),
  name         text        not null,
  currency     text        not null default 'UZS',
  timezone     text        not null default 'Asia/Tashkent',
  languages    text[]      not null default array['ru','uz'],
  created_at   timestamptz not null default now()
);

create table locations (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);
create index locations_tenant_idx on locations (tenant_id);

-- subject — идентичность из auth-api (JWT sub). Роли и организации живут здесь,
-- а не в auth-api: он остаётся воротами идентичности и ничего не знает о клиниках.
create table memberships (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  subject    text not null,
  role       text not null check (role in ('owner','doctor','assistant','admin')),
  created_at timestamptz not null default now(),
  unique (tenant_id, subject)
);
create index memberships_subject_idx on memberships (subject);

-- Календарь строится на ресурсах, а не на враче: кресло — единица дефицита,
-- ассистент один на два кресла, микроскоп один на клинику.
create table resources (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  kind        text not null check (kind in ('chair','practitioner','assistant','equipment')),
  name        text not null,
  created_at  timestamptz not null default now()
);
create index resources_tenant_idx on resources (tenant_id, location_id);

create table patients (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  full_name  text not null,
  phone      text,
  notes      text,
  created_at timestamptz not null default now()
);
create index patients_tenant_idx on patients (tenant_id);

create table appointments (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete restrict,
  status     text not null default 'scheduled' check (status in ('scheduled','cancelled','done')),
  -- Производный охват по строкам занятости: нужен ленте дня, но не ограничениям.
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index appointments_tenant_time_idx on appointments (tenant_id, starts_at);

-- Окно занятости живёт ЗДЕСЬ, а не на appointments: EXCLUDE не может ссылаться
-- на колонки другой таблицы. Побочная польза — ассистент может быть занят
-- только частью приёма.
-- Отмена записи УДАЛЯЕТ строки занятости, поэтому частичный предикат по статусу
-- не нужен: отменённый приём слот не блокирует. Факт отмены хранится в
-- appointments.status. Цена: по этой таблице нельзя восстановить, кто был
-- забронирован на отменённый приём.
create table appointment_resources (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  appointment_id uuid not null references appointments(id) on delete cascade,
  resource_id    uuid not null references resources(id) on delete restrict,
  role           text not null check (role in ('chair','practitioner','assistant','equipment')),
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  check (ends_at > starts_at),
  constraint appointment_resources_no_overlap exclude using gist (
    tenant_id   with =,
    resource_id with =,
    tstzrange(starts_at, ends_at) with &&
  )
);
create index appointment_resources_appointment_idx on appointment_resources (appointment_id);

-- appointment_id nullable: самотёк (walk-in) — норма для кабинета на 1-2 кресла.
create table visits (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  location_id    uuid not null references locations(id) on delete restrict,
  appointment_id uuid references appointments(id) on delete set null,
  patient_id     uuid not null references patients(id) on delete restrict,
  status         text not null default 'open' check (status in ('open','closed')),
  visit_date     date not null default (now() at time zone 'Asia/Tashkent')::date,
  closed_at      timestamptz,
  created_at     timestamptz not null default now(),
  check ((status = 'closed') = (closed_at is not null))
);
create index visits_tenant_status_idx on visits (tenant_id, status);
create index visits_tenant_date_idx on visits (tenant_id, visit_date);
