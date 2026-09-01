-- 008_seed_therapist_catalog (применена 20260825092424)

do $$
declare
  t uuid; loc uuid; chair uuid; doc uuid;
  u_pc uuid; u_g uuid; u_ml uuid; u_m uuid; u_carp uuid; u_pair uuid;
  grp_composite uuid;
  blk_base uuid; blk_base_v uuid;
  blk_anes uuid; blk_anes_v uuid;
  blk_iso  uuid; blk_iso_v  uuid;
  blk_xray uuid; blk_xray_v uuid;
  tc uuid; tcv uuid;
  m record;
begin
  insert into tenants (name) values ('Кабинет стоматолога-терапевта') returning id into t;
  insert into locations (tenant_id, name) values (t, 'Кабинет') returning id into loc;
  insert into resources (tenant_id, location_id, kind, name) values (t, loc, 'chair', 'Кресло 1') returning id into chair;
  insert into resources (tenant_id, location_id, kind, name) values (t, loc, 'practitioner', 'Врач') returning id into doc;

  -- Единицы. divisible = false у карпулы: вскрытая ради 0.6 мл, она стоит целиком.
  insert into units (tenant_id, code, name_ru, name_uz, divisible) values
    (t,'pc','шт','dona',false)        returning id into u_pc;
  insert into units (tenant_id, code, name_ru, name_uz, divisible) values
    (t,'g','г','g',true)              returning id into u_g;
  insert into units (tenant_id, code, name_ru, name_uz, divisible) values
    (t,'ml','мл','ml',true)           returning id into u_ml;
  insert into units (tenant_id, code, name_ru, name_uz, divisible) values
    (t,'m','м','m',true)              returning id into u_m;
  insert into units (tenant_id, code, name_ru, name_uz, divisible) values
    (t,'carpule','карпула','karpula',false) returning id into u_carp;
  insert into units (tenant_id, code, name_ru, name_uz, divisible) values
    (t,'pair','пара','juft',false)    returning id into u_pair;

  -- Материалы. reference_price — справочная цена за базовую единицу, ориентир
  -- ташкентского рынка. Врач правит её под свои закупки: это дефолт, не норматив.
  insert into materials (tenant_id, name_ru, name_uz, base_unit_id, category, reference_price)
  select t, x.ru, x.uz,
         case x.unit when 'pc' then u_pc when 'g' then u_g when 'ml' then u_ml
                     when 'm' then u_m when 'carpule' then u_carp else u_pair end,
         x.cat, x.price
  from (values
    -- базовый набор кресла
    ('Перчатки нитриловые','Nitril qoʻlqop','pc','base',600),
    ('Маска медицинская','Tibbiy niqob','pc','base',500),
    ('Салфетка нагрудная','Koʻkrak salfetkasi','pc','base',300),
    ('Стакан одноразовый','Bir martalik stakan','pc','base',200),
    ('Слюноотсос','Soʻlak soʻrgich','pc','base',400),
    ('Чехол на подголовник','Bosh tayanchi gʻilofi','pc','base',350),
    ('Бахилы','Baxila','pair','base',300),
    ('Валик ватный','Paxta rulon','pc','base',50),
    ('Салфетка дезинфицирующая','Dezinfeksiya salfetkasi','pc','base',800),
    ('Средство для дезинфекции поверхностей','Yuza dezinfektanti','ml','base',60),
    ('Рулон для стерилизации','Sterilizatsiya ruloni','m','base',4000),
    ('Индикатор стерилизации','Sterilizatsiya indikatori','pc','base',200),
    ('Хлоргексидин 0.05%','Xlorgeksidin 0.05%','ml','base',30),
    -- анестезия
    ('Карпула артикаин 4% 1:100000','Artikain karpulasi 4%','carpule','anesthesia',9000),
    ('Игла карпульная','Karpul ignasi','pc','anesthesia',2000),
    ('Гель аппликационный лидокаин 10%','Applikatsion gel lidokain','g','anesthesia',3000),
    ('Микроаппликатор','Mikroapplikator','pc','anesthesia',400),
    -- изоляция
    ('Коффердам лист','Kofferdam varagʻi','pc','isolation',3500),
    ('Кламп','Klamp','pc','isolation',90000),
    ('Флосс','Floss','m','isolation',500),
    -- рентген
    ('Чехол на сенсор','Sensor gʻilofi','pc','xray',1500),
    ('Держатель сенсора','Sensor ushlagichi','pc','xray',60000),
    -- реставрация
    ('Бор алмазный турбинный','Olmos bor','pc','resto',25000),
    ('Бор твердосплавный финишный','Qattiq qotishma bor','pc','resto',30000),
    ('Матрица секционная','Seksion matritsa','pc','resto',3000),
    ('Кольцо матричное','Matritsa halqasi','pc','resto',120000),
    ('Клин межзубный','Tishlararo xanjar','pc','resto',800),
    ('Гель протравочный 37%','Protrav geli 37%','ml','resto',12000),
    ('Адгезив','Adgeziv','ml','resto',180000),
    ('Аппликатор-кисточка','Applikator choʻtka','pc','resto',500),
    ('Композит текучий','Suyuq kompozit','g','resto',90000),
    ('Композит пломбировочный A','Plomba kompoziti A','g','resto',75000),
    ('Композит пломбировочный B','Plomba kompoziti B','g','resto',68000),
    ('Штрипс полировальный','Sayqallash shtripsi','pc','resto',2500),
    ('Диск полировальный','Sayqallash diski','pc','resto',3500),
    ('Бумага артикуляционная','Artikulyatsiya qogʻozi','pc','resto',600),
    ('Дентин-паста временная','Vaqtinchalik dentin pasta','g','resto',15000),
    -- эндодонтия
    ('Файл ручной K-file','Qoʻl fayli K-file','pc','endo',12000),
    ('Файл NiTi ротационный','NiTi rotatsion fayl','pc','endo',180000),
    ('Гипохлорит натрия 3%','Natriy gipoxlorit 3%','ml','endo',400),
    ('ЭДТА гель','EDTA geli','ml','endo',25000),
    ('Шприц эндодонтический с иглой','Endodontik shprits','pc','endo',6000),
    ('Штифт бумажный','Qogʻoz shtift','pc','endo',900),
    ('Штифт гуттаперчевый','Guttapercha shtift','pc','endo',1200),
    ('Силер','Siler','g','endo',120000),
    ('Паста гидроксид кальция','Kaltsiy gidroksid pastasi','g','endo',60000),
    -- гигиена
    ('Порошок Air Flow','Air Flow kukuni','g','hygiene',900),
    ('Насадка скалера','Skaler uchligi','pc','hygiene',400000),
    ('Щётка полировальная','Sayqallash choʻtkasi','pc','hygiene',4000),
    ('Резинка полировальная','Sayqallash rezinkasi','pc','hygiene',3500),
    ('Паста полировальная','Sayqallash pastasi','g','hygiene',8000),
    ('Фторлак','Ftorlak','ml','hygiene',40000),
    ('Таблетка-индикатор налёта','Karash indikatori','pc','hygiene',2000)
  ) as x(ru, uz, unit, cat, price);

  -- Группа аналогов: врач держит два композита, FEFO выбирает внутри группы.
  -- Смешивание внутри одной строки запрещено — это ровно то, чего нет у конкурентов.
  insert into analog_groups (tenant_id, name) values (t, 'Композит пломбировочный') returning id into grp_composite;
  insert into analog_group_members (group_id, material_id, priority)
  select grp_composite, id, case when name_ru like '%A' then 0 else 1 end
    from materials where tenant_id = t and name_ru like 'Композит пломбировочный%';

  -- ── Блоки: заводятся ОДИН раз и подключаются к десяткам карт ──────────────
  -- Строки блоков по умолчанию НЕ масштабируются на quantity: моляр с тремя
  -- каналами расходует втрое больше гипохлорита, но одну пару перчаток.

  insert into techcard_blocks (tenant_id, code, name_ru, name_uz)
    values (t,'base','Базовый набор кресла','Kreslo asosiy toʻplami') returning id into blk_base;
  insert into techcard_block_versions (block_id, version) values (blk_base, 1) returning id into blk_base_v;
  insert into techcard_block_lines (block_version_id, material_id, norm_qty, unit_id, scales_with_quantity)
  select blk_base_v, mt.id, x.qty,
         case x.unit when 'pc' then u_pc when 'ml' then u_ml when 'm' then u_m else u_pair end, false
  from (values
    ('Перчатки нитриловые',4,'pc'),('Маска медицинская',1,'pc'),('Салфетка нагрудная',1,'pc'),
    ('Стакан одноразовый',1,'pc'),('Слюноотсос',1,'pc'),('Чехол на подголовник',1,'pc'),
    ('Бахилы',1,'pair'),('Валик ватный',4,'pc'),('Салфетка дезинфицирующая',2,'pc'),
    ('Средство для дезинфекции поверхностей',10,'ml'),('Рулон для стерилизации',0.3,'m'),
    ('Индикатор стерилизации',1,'pc'),('Хлоргексидин 0.05%',15,'ml')
  ) as x(ru, qty, unit)
  join materials mt on mt.tenant_id = t and mt.name_ru = x.ru;

  insert into techcard_blocks (tenant_id, code, name_ru, name_uz)
    values (t,'anesthesia','Анестезия','Anesteziya') returning id into blk_anes;
  insert into techcard_block_versions (block_id, version) values (blk_anes, 1) returning id into blk_anes_v;
  insert into techcard_block_lines (block_version_id, material_id, norm_qty, unit_id, scales_with_quantity)
  select blk_anes_v, mt.id, x.qty,
         case x.unit when 'pc' then u_pc when 'g' then u_g else u_carp end, false
  from (values
    ('Карпула артикаин 4% 1:100000',1,'carpule'),('Игла карпульная',1,'pc'),
    ('Гель аппликационный лидокаин 10%',0.3,'g'),('Микроаппликатор',1,'pc')
  ) as x(ru, qty, unit)
  join materials mt on mt.tenant_id = t and mt.name_ru = x.ru;

  insert into techcard_blocks (tenant_id, code, name_ru, name_uz)
    values (t,'isolation','Изоляция','Izolyatsiya') returning id into blk_iso;
  insert into techcard_block_versions (block_id, version) values (blk_iso, 1) returning id into blk_iso_v;
  insert into techcard_block_lines (block_version_id, material_id, norm_qty, unit_id, scales_with_quantity)
  select blk_iso_v, mt.id, x.qty,
         case x.unit when 'pc' then u_pc else u_m end, false
  from (values
    ('Коффердам лист',1,'pc'),('Кламп',0.02,'pc'),('Флосс',0.2,'m')
  ) as x(ru, qty, unit)
  join materials mt on mt.tenant_id = t and mt.name_ru = x.ru;

  insert into techcard_blocks (tenant_id, code, name_ru, name_uz)
    values (t,'xray','Рентген-контроль','Rentgen nazorati') returning id into blk_xray;
  insert into techcard_block_versions (block_id, version) values (blk_xray, 1) returning id into blk_xray_v;
  insert into techcard_block_lines (block_version_id, material_id, norm_qty, unit_id, scales_with_quantity)
  select blk_xray_v, mt.id, x.qty, u_pc, false
  from (values ('Чехол на сенсор',1),('Держатель сенсора',0.05)) as x(ru, qty)
  join materials mt on mt.tenant_id = t and mt.name_ru = x.ru;

  raise notice 'каталог создан для тенанта %', t;
end $$;
select count(*) as materials from materials;;
