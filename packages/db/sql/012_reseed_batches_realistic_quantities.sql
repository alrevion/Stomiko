-- 012_reseed_batches_realistic_quantities (применена 20260825092726)

do $$
declare
  t uuid; loc uuid; r record; bid uuid; n int := 0;
begin
  select id into t from tenants where name = 'Кабинет стоматолога-терапевта';
  select id into loc from locations where tenant_id = t;

  delete from stock_movements where tenant_id = t and kind = 'receipt';
  delete from batches where tenant_id = t;

  -- Объёмы под месяц работы кабинета на одно кресло. Расходники закупаются
  -- упаковками, износные позиции (боры, клампы, насадки, кольца) — штучно:
  -- кабинет держит два матричных кольца, а не триста.
  for r in
    select mt.id, mt.name_ru, mt.reference_price, x.qty, x.months
    from (values
      ('Перчатки нитриловые',300,14),('Маска медицинская',100,14),
      ('Салфетка нагрудная',200,14),('Стакан одноразовый',200,14),
      ('Слюноотсос',200,14),('Чехол на подголовник',200,14),('Бахилы',200,14),
      ('Валик ватный',1000,14),('Салфетка дезинфицирующая',200,14),
      ('Средство для дезинфекции поверхностей',3000,14),
      ('Рулон для стерилизации',100,24),('Индикатор стерилизации',200,14),
      ('Хлоргексидин 0.05%',3000,10),
      ('Карпула артикаин 4% 1:100000',100,18),('Игла карпульная',100,24),
      ('Гель аппликационный лидокаин 10%',20,12),('Микроаппликатор',200,24),
      ('Коффердам лист',100,18),('Кламп',4,60),('Флосс',50,24),
      ('Чехол на сенсор',200,18),('Держатель сенсора',2,60),
      ('Бор алмазный турбинный',50,60),('Бор твердосплавный финишный',30,60),
      ('Матрица секционная',100,36),('Кольцо матричное',2,60),('Клин межзубный',200,36),
      ('Гель протравочный 37%',10,18),('Адгезив',10,12),('Аппликатор-кисточка',200,24),
      ('Композит текучий',8,20),('Композит пломбировочный A',12,20),
      ('Композит пломбировочный B',8,20),
      ('Штрипс полировальный',100,36),('Диск полировальный',50,36),
      ('Бумага артикуляционная',100,24),('Дентин-паста временная',40,18),
      ('Файл ручной K-file',30,60),('Файл NiTi ротационный',12,60),
      ('Гипохлорит натрия 3%',2000,8),('ЭДТА гель',20,18),
      ('Шприц эндодонтический с иглой',50,24),('Штифт бумажный',200,24),
      ('Штифт гуттаперчевый',200,24),('Силер',15,18),('Паста гидроксид кальция',15,18),
      ('Порошок Air Flow',500,18),('Насадка скалера',2,60),
      ('Щётка полировальная',50,24),('Резинка полировальная',50,24),
      ('Паста полировальная',60,18),('Фторлак',20,12),('Таблетка-индикатор налёта',50,18)
    ) as x(ru, qty, months)
    join materials mt on mt.tenant_id = t and mt.name_ru = x.ru
  loop
    insert into batches (tenant_id, location_id, material_id, initial_qty, qty_remaining,
                         total_price, expires_at, supplier)
      values (t, loc, r.id, r.qty, r.qty, round(r.reference_price * r.qty, 2),
              (current_date + (r.months || ' months')::interval)::date, 'Дистрибьютор (демо)')
      returning id into bid;
    insert into stock_movements (tenant_id, location_id, kind, batch_id, material_id, qty_delta, cost, unpriced)
      values (t, loc, 'receipt', bid, r.id, r.qty, round(r.reference_price * r.qty, 2), false);
    n := n + 1;
  end loop;

  -- Старая партия композита A с близким сроком: FEFO обязан взять её первой.
  -- Без неё в демо не видно, что аллокатор вообще ветвится по срокам годности.
  for r in select id, reference_price from materials where tenant_id=t and name_ru='Композит пломбировочный A' loop
    insert into batches (tenant_id, location_id, material_id, initial_qty, qty_remaining,
                         total_price, expires_at, supplier)
      values (t, loc, r.id, 4, 4, round(r.reference_price * 4, 2),
              (current_date + interval '2 months')::date, 'Дистрибьютор (демо), остаток прошлой закупки')
      returning id into bid;
    insert into stock_movements (tenant_id, location_id, kind, batch_id, material_id, qty_delta, cost, unpriced)
      values (t, loc, 'receipt', bid, r.id, 4, round(r.reference_price * 4, 2), false);
    n := n + 1;
  end loop;

  raise notice 'партий: %', n;
end $$;

do $$
declare bad int;
begin
  select count(*) into bad from reconcile_batches((select id from tenants where name='Кабинет стоматолога-терапевта'));
  if bad > 0 then raise exception 'проекция qty_remaining разошлась с журналом на % партиях', bad; end if;
end $$;;
