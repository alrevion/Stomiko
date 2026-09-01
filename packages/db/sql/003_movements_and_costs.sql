-- Stomiko 003: оказанные услуги, журнал движений, снимок себестоимости.

create table visit_services (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  visit_id            uuid not null references visits(id) on delete cascade,
  service_id          uuid not null references services(id) on delete restrict,
  -- quantity — это ЕДИНИЦА НОРМИРОВАНИЯ услуги, а не число зубов.
  -- Моляр с тремя каналами при unit_of_norm='canal' даёт quantity = 3.
  quantity            int not null default 1 check (quantity >= 1),
  price               numeric(18,2) not null check (price >= 0),
  -- Версия техкарты фиксируется в момент оказания: ретроактивная правка
  -- техкарты не должна менять закрытый приём.
  techcard_version_id uuid references techcard_versions(id) on delete restrict,
  created_at          timestamptz not null default now()
);
create index visit_services_visit_idx on visit_services (visit_id);

-- Журнал со знаком. batches.qty_remaining — его проекция, а не отдельная истина.
-- shortfall: batch_id = NULL, потому что недостача не списывается ни с какой партии.
-- Она не ошибка, а строка движения: закрытие приёма нельзя отвергнуть по остатку.
create table stock_movements (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  location_id    uuid not null references locations(id) on delete restrict,
  visit_id       uuid references visits(id) on delete restrict,
  kind           text not null check (kind in ('receipt','consume','shortfall','adjustment','write_off','reversal')),
  batch_id       uuid references batches(id) on delete restrict,
  material_id    uuid not null references materials(id) on delete restrict,
  -- Влияние на остаток партии: приход +, расход −. У shortfall влияния нет.
  qty_delta      numeric(18,6) not null,
  -- Стоимость, отнесённая на приём: положительная для расхода, отрицательная
  -- для reversal. NULL — цена неизвестна; ноль как заглушка ЗАПРЕЩЁН, иначе
  -- маржа показалась бы стопроцентной.
  cost           numeric(18,6),
  unpriced       boolean not null default false,
  -- Жизненный цикл недостачи: бейдж на складском экране считает только open.
  shortfall_state text check (shortfall_state in ('open','acknowledged')),
  reversal_of    uuid references stock_movements(id) on delete restrict,
  reason         text,
  created_at     timestamptz not null default now(),
  check (unpriced = (cost is null)),
  check ((kind = 'shortfall') = (batch_id is null)),
  check ((kind = 'shortfall') = (shortfall_state is not null)),
  check ((kind = 'reversal') = (reversal_of is not null)),
  check ((kind = 'shortfall') or (qty_delta <> 0))
);
create index stock_movements_batch_idx on stock_movements (batch_id);
create index stock_movements_visit_idx on stock_movements (visit_id);
create index stock_movements_open_shortfall_idx on stock_movements (tenant_id)
  where kind = 'shortfall' and shortfall_state = 'open';

-- Снимок себестоимости. materials_total НИКОГДА не NULL: это сумма строк с
-- известной ценой. Неизвестная часть выражается флагами, иначе инвариант
-- Σ(cost) == materials_total перестаёт быть проверяемым.
create table visit_costs (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  visit_id            uuid not null references visits(id) on delete cascade,
  materials_total     numeric(18,6) not null default 0,
  has_unpriced        boolean not null default false,
  unpriced_lines_count int not null default 0 check (unpriced_lines_count >= 0),
  direct_costs        numeric(18,6) not null default 0,
  total               numeric(18,6) not null default 0,
  computed_at         timestamptz not null default now(),
  -- Reversal не удаляет снимок, а помечает его: история себестоимости сохраняется.
  superseded_at       timestamptz,
  check (has_unpriced = (unpriced_lines_count > 0))
);
-- Активный снимок ровно один; предыдущие остаются с проставленным superseded_at.
create unique index visit_costs_active_uq on visit_costs (visit_id) where superseded_at is null;
create index visit_costs_visit_idx on visit_costs (visit_id);
