-- 009_seed_therapist_techcards_and_services (применена 20260825092520)

do $$
declare
  t uuid; u_pc uuid; u_g uuid; u_ml uuid;
  grp uuid;
  b_base uuid; b_anes uuid; b_iso uuid; b_xray uuid;
  tc uuid; tcv uuid;
  n int;
begin
  select id into t from tenants where name = 'Кабинет стоматолога-терапевта';
  select id into u_pc from units where tenant_id=t and code='pc';
  select id into u_g  from units where tenant_id=t and code='g';
  select id into u_ml from units where tenant_id=t and code='ml';
  select id into grp  from analog_groups where tenant_id=t;
  select bv.id into b_base from techcard_block_versions bv join techcard_blocks bb on bb.id=bv.block_id where bb.tenant_id=t and bb.code='base';
  select bv.id into b_anes from techcard_block_versions bv join techcard_blocks bb on bb.id=bv.block_id where bb.tenant_id=t and bb.code='anesthesia';
  select bv.id into b_iso  from techcard_block_versions bv join techcard_blocks bb on bb.id=bv.block_id where bb.tenant_id=t and bb.code='isolation';
  select bv.id into b_xray from techcard_block_versions bv join techcard_blocks bb on bb.id=bv.block_id where bb.tenant_id=t and bb.code='xray';

  -- ── 1. Приём первичный: только базовый блок ──────────────────────────────
  insert into techcards (tenant_id, name_ru, name_uz) values (t,'Приём первичный','Birlamchi qabul') returning id into tc;
  insert into techcard_versions (techcard_id, version) values (tc,1) returning id into tcv;
  insert into techcard_lines (techcard_version_id, block_version_id) values (tcv, b_base);
  perform expand_techcard_version(tcv);
  insert into services (tenant_id, code, name_ru, name_uz, price, unit_of_norm, techcard_version_id)
    values (t,'B01.065.007','Приём врача-стоматолога первичный','Stomatolog birlamchi qabuli',350000,'session',tcv);

  -- ── 2. Пломба фотополимером I/V/VI класс ─────────────────────────────────
  insert into techcards (tenant_id, name_ru, name_uz) values (t,'Пломба фотополимером I/V/VI','Fotopolimer plomba I/V/VI') returning id into tc;
  insert into techcard_versions (techcard_id, version) values (tc,1) returning id into tcv;
  insert into techcard_lines (techcard_version_id, block_version_id) values (tcv,b_base),(tcv,b_anes),(tcv,b_iso);
  insert into techcard_lines (techcard_version_id, material_id, norm_qty, unit_id, scales_with_quantity)
  select tcv, mt.id, x.qty, case x.u when 'pc' then u_pc when 'g' then u_g else u_ml end, true
  from (values
    ('Бор алмазный турбинный',0.3,'pc'),('Бор твердосплавный финишный',0.2,'pc'),
    ('Гель протравочный 37%',0.3,'ml'),('Адгезив',0.15,'ml'),
    ('Аппликатор-кисточка',2,'pc'),('Композит текучий',0.1,'g'),
    ('Штрипс полировальный',1,'pc'),('Диск полировальный',0.5,'pc'),
    ('Бумага артикуляционная',1,'pc')
  ) as x(ru,qty,u) join materials mt on mt.tenant_id=t and mt.name_ru=x.ru;
  -- Композит идёт группой аналогов: врач держит два бренда, FEFO выберет внутри группы.
  insert into techcard_lines (techcard_version_id, analog_group_id, norm_qty, unit_id, scales_with_quantity)
    values (tcv, grp, 0.25, u_g, true);
  perform expand_techcard_version(tcv);
  insert into services (tenant_id, code, name_ru, name_uz, price, unit_of_norm, techcard_version_id)
    values (t,'A16.07.002.010','Пломба фотополимером I/V/VI класс','Fotopolimer plomba I/V/VI sinf',790000,'surface',tcv);

  -- ── 3. Пломба фотополимером II/III класс: контактный пункт ───────────────
  insert into techcards (tenant_id, name_ru, name_uz) values (t,'Пломба фотополимером II/III','Fotopolimer plomba II/III') returning id into tc;
  insert into techcard_versions (techcard_id, version) values (tc,1) returning id into tcv;
  insert into techcard_lines (techcard_version_id, block_version_id) values (tcv,b_base),(tcv,b_anes),(tcv,b_iso);
  insert into techcard_lines (techcard_version_id, material_id, norm_qty, unit_id, scales_with_quantity)
  select tcv, mt.id, x.qty, case x.u when 'pc' then u_pc when 'g' then u_g else u_ml end, true
  from (values
    ('Бор алмазный турбинный',0.3,'pc'),('Бор твердосплавный финишный',0.2,'pc'),
    ('Матрица секционная',1,'pc'),('Кольцо матричное',0.05,'pc'),('Клин межзубный',1,'pc'),
    ('Гель протравочный 37%',0.3,'ml'),('Адгезив',0.15,'ml'),
    ('Аппликатор-кисточка',2,'pc'),('Композит текучий',0.1,'g'),
    ('Штрипс полировальный',1,'pc'),('Диск полировальный',0.5,'pc'),
    ('Бумага артикуляционная',1,'pc')
  ) as x(ru,qty,u) join materials mt on mt.tenant_id=t and mt.name_ru=x.ru;
  insert into techcard_lines (techcard_version_id, analog_group_id, norm_qty, unit_id, scales_with_quantity)
    values (tcv, grp, 0.4, u_g, true);
  perform expand_techcard_version(tcv);
  insert into services (tenant_id, code, name_ru, name_uz, price, unit_of_norm, techcard_version_id)
    values (t,'A16.07.002.011','Пломба фотополимером II/III класс','Fotopolimer plomba II/III sinf',950000,'surface',tcv);

  -- ── 4. Временная пломба ──────────────────────────────────────────────────
  insert into techcards (tenant_id, name_ru, name_uz) values (t,'Временная пломба','Vaqtinchalik plomba') returning id into tc;
  insert into techcard_versions (techcard_id, version) values (tc,1) returning id into tcv;
  insert into techcard_lines (techcard_version_id, block_version_id) values (tcv,b_base);
  insert into techcard_lines (techcard_version_id, material_id, norm_qty, unit_id, scales_with_quantity)
  select tcv, mt.id, x.qty, case x.u when 'pc' then u_pc else u_g end, true
  from (values ('Дентин-паста временная',0.5,'g'),('Бумага артикуляционная',1,'pc'))
    as x(ru,qty,u) join materials mt on mt.tenant_id=t and mt.name_ru=x.ru;
  perform expand_techcard_version(tcv);
  insert into services (tenant_id, code, name_ru, name_uz, price, unit_of_norm, techcard_version_id)
    values (t,'A16.07.002.009','Наложение временной пломбы','Vaqtinchalik plomba qoʻyish',150000,'tooth',tcv);

  -- ── 5. Обработка канала. ЕДИНИЦА НОРМИРОВАНИЯ — КАНАЛ, не зуб ────────────
  -- Блоки не масштабируются: моляр с тремя каналами = одна карпула, но втрое
  -- больше гипохлорита и файлов.
  insert into techcards (tenant_id, name_ru, name_uz) values (t,'Обработка корневого канала','Ildiz kanalini ishlov berish') returning id into tc;
  insert into techcard_versions (techcard_id, version) values (tc,1) returning id into tcv;
  insert into techcard_lines (techcard_version_id, block_version_id) values (tcv,b_base),(tcv,b_anes),(tcv,b_iso),(tcv,b_xray);
  insert into techcard_lines (techcard_version_id, material_id, norm_qty, unit_id, scales_with_quantity)
  select tcv, mt.id, x.qty, case x.u when 'pc' then u_pc when 'g' then u_g else u_ml end, true
  from (values
    ('Файл ручной K-file',0.3,'pc'),('Файл NiTi ротационный',0.33,'pc'),
    ('Гипохлорит натрия 3%',10,'ml'),('ЭДТА гель',0.2,'ml'),
    ('Шприц эндодонтический с иглой',1,'pc'),('Штифт бумажный',4,'pc'),
    ('Паста гидроксид кальция',0.2,'g')
  ) as x(ru,qty,u) join materials mt on mt.tenant_id=t and mt.name_ru=x.ru;
  perform expand_techcard_version(tcv);
  insert into services (tenant_id, code, name_ru, name_uz, price, unit_of_norm, techcard_version_id)
    values (t,'A16.07.030.001','Обработка корневого канала','Ildiz kanalini ishlov berish',300000,'canal',tcv);

  -- ── 6. Пломбирование канала гуттаперчей, тоже на канал ───────────────────
  insert into techcards (tenant_id, name_ru, name_uz) values (t,'Пломбирование канала гуттаперчей','Kanalni guttapercha bilan plombalash') returning id into tc;
  insert into techcard_versions (techcard_id, version) values (tc,1) returning id into tcv;
  insert into techcard_lines (techcard_version_id, block_version_id) values (tcv,b_base),(tcv,b_iso),(tcv,b_xray);
  insert into techcard_lines (techcard_version_id, material_id, norm_qty, unit_id, scales_with_quantity)
  select tcv, mt.id, x.qty, case x.u when 'pc' then u_pc else u_g end, true
  from (values
    ('Штифт гуттаперчевый',3,'pc'),('Штифт бумажный',3,'pc'),
    ('Силер',0.15,'g'),('Дентин-паста временная',0.5,'g')
  ) as x(ru,qty,u) join materials mt on mt.tenant_id=t and mt.name_ru=x.ru;
  perform expand_techcard_version(tcv);
  insert into services (tenant_id, code, name_ru, name_uz, price, unit_of_norm, techcard_version_id)
    values (t,'A16.07.008.002','Пломбирование канала гуттаперчей','Kanalni guttapercha bilan plombalash',250000,'canal',tcv);

  -- ── 7. Профгигиена ───────────────────────────────────────────────────────
  insert into techcards (tenant_id, name_ru, name_uz) values (t,'Профессиональная гигиена','Professional gigiyena') returning id into tc;
  insert into techcard_versions (techcard_id, version) values (tc,1) returning id into tcv;
  insert into techcard_lines (techcard_version_id, block_version_id) values (tcv,b_base);
  insert into techcard_lines (techcard_version_id, material_id, norm_qty, unit_id, scales_with_quantity)
  select tcv, mt.id, x.qty, case x.u when 'pc' then u_pc when 'g' then u_g else u_ml end, true
  from (values
    ('Порошок Air Flow',15,'g'),('Насадка скалера',0.05,'pc'),
    ('Щётка полировальная',1,'pc'),('Резинка полировальная',1,'pc'),
    ('Паста полировальная',1.5,'g'),('Фторлак',0.5,'ml'),
    ('Таблетка-индикатор налёта',1,'pc')
  ) as x(ru,qty,u) join materials mt on mt.tenant_id=t and mt.name_ru=x.ru;
  perform expand_techcard_version(tcv);
  insert into services (tenant_id, code, name_ru, name_uz, price, unit_of_norm, techcard_version_id)
    values (t,'A16.07.051','Профессиональная гигиена полости рта','Ogʻiz boʻshligʻi professional gigiyenasi',400000,'jaw',tcv);

  -- ── 8. Прицельный снимок ─────────────────────────────────────────────────
  insert into techcards (tenant_id, name_ru, name_uz) values (t,'Прицельный снимок','Nishonli suratga olish') returning id into tc;
  insert into techcard_versions (techcard_id, version) values (tc,1) returning id into tcv;
  insert into techcard_lines (techcard_version_id, block_version_id) values (tcv,b_xray);
  perform expand_techcard_version(tcv);
  insert into services (tenant_id, code, name_ru, name_uz, price, unit_of_norm, techcard_version_id)
    values (t,'A06.07.003','Прицельная внутриротовая рентгенография','Nishonli ogʻiz ichi rentgenografiyasi',60000,'tooth',tcv);

  select count(*) into n from services where tenant_id = t;
  raise notice 'создано услуг: %', n;
end $$;
select s.code, s.name_ru, s.price, s.unit_of_norm,
       (select count(*) from techcard_expanded te where te.techcard_version_id = s.techcard_version_id) as lines
from services s order by s.code;;
