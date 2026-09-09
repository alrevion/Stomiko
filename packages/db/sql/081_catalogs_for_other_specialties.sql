-- 081_catalogs_for_other_specialties

-- Справочники для остальных специализаций.
--
-- До сих пор стартовый справочник был один — терапевтический. Ортопед,
-- получив его, видел себестоимость коронки, собранную из композита и
-- эндодонтических файлов, то есть неправду. Пустой справочник был бы
-- честнее, но бесполезен: ради расчёта себестоимости продукт и берут.
--
-- Общая часть — единицы, базовый набор кресла, анестезия, изоляция и
-- рентген-контроль — у всех одна и копируется из терапевта: это не
-- специальность, это кабинет. Различаются материалы ремесла и услуги.
--
-- ВАЖНО ПРО ЦИФРЫ. Нормы расхода и цены здесь — стартовые, собранные по
-- типовой практике, а не выписанные из чьей-то накладной. Врач правит их
-- под себя в первый же день: у одного цирконий из одной лаборатории, у
-- другого из другой, и «как у всех» тут не бывает. Экран «Сверьте
-- справочник» показывается сразу после регистрации именно поэтому.

insert into catalog_templates (code, name_ru, specialty, is_active) values
  ('surgeon',      'Стоматолог-хирург',  'surgeon',      true),
  ('orthopedist',  'Стоматолог-ортопед', 'orthopedist',  true),
  ('orthodontist', 'Ортодонт',           'orthodontist', true),
  ('pediatric',    'Детский стоматолог', 'pediatric',    true),
  ('periodontist', 'Пародонтолог',       'periodontist', true)
on conflict (code) do update
  set name_ru = excluded.name_ru, specialty = excluded.specialty, is_active = true;

-- ── Общая часть: то, что есть в любом кабинете ────────────────────────────

insert into template_units (template_id, code, name_ru, name_uz, factor, divisible)
select n.id, u.code, u.name_ru, u.name_uz, u.factor, u.divisible
  from catalog_templates n, template_units u
 where n.code in ('surgeon','orthopedist','orthodontist','pediatric','periodontist')
   and u.template_id = (select id from catalog_templates where code = 'therapist')
   and not exists (select 1 from template_units x
                    where x.template_id = n.id and x.code = u.code);

insert into template_materials (template_id, name_ru, name_uz, category, unit_code, reference_price)
select n.id, m.name_ru, m.name_uz, m.category, m.unit_code, m.reference_price
  from catalog_templates n, template_materials m
 where n.code in ('surgeon','orthopedist','orthodontist','pediatric','periodontist')
   and m.template_id = (select id from catalog_templates where code = 'therapist')
   and m.category in ('base', 'anesthesia', 'isolation', 'xray')
   and not exists (select 1 from template_materials x
                    where x.template_id = n.id and x.name_ru = m.name_ru);

insert into template_blocks (template_id, code, name_ru, name_uz)
select n.id, b.code, b.name_ru, b.name_uz
  from catalog_templates n, template_blocks b
 where n.code in ('surgeon','orthopedist','orthodontist','pediatric','periodontist')
   and b.template_id = (select id from catalog_templates where code = 'therapist')
   and not exists (select 1 from template_blocks x
                    where x.template_id = n.id and x.code = b.code);

insert into template_block_lines (block_id, material_name, norm_qty, unit_code, scales_with_quantity)
select nb.id, l.material_name, l.norm_qty, l.unit_code, l.scales_with_quantity
  from catalog_templates n
  join template_blocks ob on ob.template_id = (select id from catalog_templates where code = 'therapist')
  join template_block_lines l on l.block_id = ob.id
  join template_blocks nb on nb.template_id = n.id and nb.code = ob.code
 where n.code in ('surgeon','orthopedist','orthodontist','pediatric','periodontist')
   and not exists (select 1 from template_block_lines x
                    where x.block_id = nb.id and x.material_name = l.material_name);

-- Часть материалов терапевта нужна и соседям: бор, артикуляционная бумага,
-- адгезив и протравка — это не специальность, а расходники соседнего шкафа.
insert into template_materials (template_id, name_ru, name_uz, category, unit_code, reference_price)
select n.id, m.name_ru, m.name_uz, m.category, m.unit_code, m.reference_price
  from catalog_templates n, template_materials m
 where n.code in ('surgeon','orthopedist','orthodontist','pediatric','periodontist')
   and m.template_id = (select id from catalog_templates where code = 'therapist')
   and (
     (n.code = 'orthopedist'  and m.name_ru in ('Бор алмазный турбинный','Бор твердосплавный финишный','Бумага артикуляционная','Диск полировальный'))
  or (n.code = 'orthodontist' and m.name_ru in ('Бор алмазный турбинный','Бор твердосплавный финишный','Гель протравочный 37%','Аппликатор-кисточка','Паста полировальная','Щётка полировальная'))
  or (n.code = 'pediatric'    and m.name_ru in ('Бор алмазный турбинный','Бор твердосплавный финишный','Бумага артикуляционная','Гель протравочный 37%','Аппликатор-кисточка','Адгезив','Композит текучий','Композит пломбировочный A','Композит пломбировочный B','Диск полировальный','Фторлак','Паста полировальная','Щётка полировальная'))
  or (n.code = 'periodontist' and m.name_ru in ('Насадка скалера','Паста полировальная','Щётка полировальная','Порошок Air Flow','Гель протравочный 37%','Аппликатор-кисточка','Адгезив','Композит текучий','Бор алмазный турбинный'))
  or (n.code = 'surgeon'      and m.name_ru in ('Бор алмазный турбинный'))
   )
   and not exists (select 1 from template_materials x
                    where x.template_id = n.id and x.name_ru = m.name_ru);

-- Детский стоматолог пломбирует, значит ему нужна и группа взаимозаменяемых
-- композитов: списывается тот, что в наличии, а не тот, что вписан в карту.
insert into template_analog_groups (template_id, name)
select n.id, 'Композит пломбировочный' from catalog_templates n where n.code = 'pediatric'
   and not exists (select 1 from template_analog_groups x
                    where x.template_id = n.id and x.name = 'Композит пломбировочный');

insert into template_analog_members (group_id, material_name, priority)
select g.id, v.m, v.p
  from template_analog_groups g
  join catalog_templates n on n.id = g.template_id and n.code = 'pediatric'
  cross join (values ('Композит пломбировочный A', 1), ('Композит пломбировочный B', 2)) as v(m, p)
 where g.name = 'Композит пломбировочный'
   and not exists (select 1 from template_analog_members x
                    where x.group_id = g.id and x.material_name = v.m);

-- ── Материалы ремесла ─────────────────────────────────────────────────────

insert into template_materials (template_id, name_ru, name_uz, category, unit_code, reference_price)
select n.id, v.ru, v.uz, v.cat, v.unit, v.price
  from catalog_templates n
  join (values
    -- Хирург
    ('surgeon','Скальпель одноразовый','Bir martalik skalpel','surgery','pc',8000),
    ('surgeon','Шовный материал','Tikuv materiali','surgery','pc',25000),
    ('surgeon','Губка гемостатическая','Gemostatik gubka','surgery','pc',35000),
    ('surgeon','Перчатки стерильные хирургические','Steril jarrohlik qoʻlqoplari','surgery','pair',4000),
    ('surgeon','Простыня стерильная','Steril choyshab','surgery','pc',12000),
    ('surgeon','Шприц 5 мл','Shprits 5 ml','surgery','pc',1500),
    ('surgeon','Физраствор 0.9%','Fiziologik eritma 0.9%','surgery','ml',30),
    ('surgeon','Бор хирургический','Jarrohlik bori','surgery','pc',35000),
    ('surgeon','Турунда йодоформная','Yodoform turunda','surgery','m',30000),
    ('surgeon','Паста от альвеолита','Alveolitga qarshi pasta','surgery','g',90000),
    ('surgeon','Имплантат дентальный','Dental implantat','implant','pc',3000000),
    ('surgeon','Формирователь десны','Milk shakllantirgichi','implant','pc',450000),
    ('surgeon','Фреза имплантологическая','Implantologik freza','implant','pc',900000),
    ('surgeon','Костный материал','Suyak materiali','implant','g',2000000),
    ('surgeon','Мембрана коллагеновая','Kollagen membrana','implant','pc',1500000),
    -- Ортопед
    ('orthopedist','Масса оттискная базовая','Asosiy ottisk massasi','ortho','g',1200),
    ('orthopedist','Масса оттискная корригирующая','Korrigirlovchi ottisk massasi','ortho','ml',7000),
    ('orthopedist','Ложка оттискная одноразовая','Bir martalik ottisk qoshigʻi','ortho','pc',6000),
    ('orthopedist','Гипс стоматологический IV класса','IV sinf stomatologik gips','ortho','g',500),
    ('orthopedist','Нить ретракционная','Retraksion ip','ortho','m',120000),
    ('orthopedist','Цемент фиксирующий стеклоиономерный','Fiksatsiya sement','ortho','g',120000),
    ('orthopedist','Цемент временный','Vaqtinchalik sement','ortho','g',40000),
    ('orthopedist','Пластмасса для временных коронок','Vaqtinchalik toj plastmassasi','ortho','g',90000),
    ('orthopedist','Коронка металлокерамическая (лаборатория)','Metallokeramik toj','lab','pc',900000),
    ('orthopedist','Коронка керамическая (лаборатория)','Keramik toj','lab','pc',2200000),
    ('orthopedist','Вкладка культевая (лаборатория)','Kultevoy qoplama','lab','pc',450000),
    ('orthopedist','Протез съёмный (лаборатория)','Olinadigan protez','lab','pc',2200000),
    ('orthopedist','Воск базисный','Asosiy mum','ortho','g',3000),
    -- Ортодонт
    ('orthodontist','Брекет металлический','Metall breket','orthodontics','pc',45000),
    ('orthodontist','Брекет керамический','Keramik breket','orthodontics','pc',110000),
    ('orthodontist','Дуга ортодонтическая NiTi','NiTi ortodontik yoy','orthodontics','pc',60000),
    ('orthodontist','Лигатура эластичная','Elastik ligatura','orthodontics','pc',500),
    ('orthodontist','Кольцо ортодонтическое','Ortodontik halqa','orthodontics','pc',90000),
    ('orthodontist','Кольцо сепарационное','Separatsion halqa','orthodontics','pc',1500),
    ('orthodontist','Адгезив ортодонтический','Ortodontik adgeziv','orthodontics','g',250000),
    ('orthodontist','Праймер ортодонтический','Ortodontik praymer','orthodontics','ml',300000),
    ('orthodontist','Проволока ретенционная','Retensiya sim','orthodontics','m',150000),
    ('orthodontist','Масса оттискная альгинатная','Alginat ottisk massasi','orthodontics','g',400),
    ('orthodontist','Ложка оттискная одноразовая','Bir martalik ottisk qoshigʻi','orthodontics','pc',6000),
    -- Детский
    ('pediatric','Цемент стеклоиономерный пломбировочный','Shisha ionomer sement','pedo','g',90000),
    ('pediatric','Силант для фиссур','Fissura silanti','pedo','g',250000),
    ('pediatric','Фторид диамина серебра','Kumush diamin ftoridi','pedo','ml',220000),
    ('pediatric','Паста для пульпотомии','Pulpotomiya pastasi','pedo','g',400000),
    -- Пародонтолог
    ('periodontist','Кюрета Грейси','Grasi kyuretasi','perio','pc',350000),
    ('periodontist','Лента стекловолоконная','Shishatolali lenta','perio','m',900000),
    ('periodontist','Гель для пародонтального кармана','Parodontal cho''ntak geli','perio','g',150000),
    ('periodontist','Шовный материал','Tikuv materiali','perio','pc',25000),
    ('periodontist','Скальпель одноразовый','Bir martalik skalpel','perio','pc',8000)
  ) as v(tpl, ru, uz, cat, unit, price) on v.tpl = n.code
 where not exists (select 1 from template_materials x
                    where x.template_id = n.id and x.name_ru = v.ru);

-- ── Услуги ────────────────────────────────────────────────────────────────

insert into template_services (template_id, code, name_ru, name_uz, price, unit_of_norm, duration_minutes, bookable, techcard_name_ru)
select n.id, v.code, v.ru, v.uz, v.price, v.unit, v.mins, v.book, v.tc
  from catalog_templates n
  join (values
    ('surgeon','B01.067.001','Приём врача-стоматолога-хирурга первичный','Jarroh stomatolog birlamchi qabuli',350000,'session',20,true,'Приём хирурга'),
    ('surgeon','A16.07.001.001','Удаление зуба простое','Tishni oddiy olib tashlash',400000,'tooth',30,true,'Удаление простое'),
    ('surgeon','A16.07.001.002','Удаление зуба сложное','Tishni murakkab olib tashlash',800000,'tooth',60,true,'Удаление сложное'),
    ('surgeon','A16.07.024','Удаление ретинированного зуба','Retinirlangan tishni olib tashlash',1500000,'tooth',90,true,'Удаление ретинированного'),
    ('surgeon','A16.07.007','Резекция верхушки корня','Ildiz uchini rezeksiya qilish',1800000,'tooth',90,true,'Резекция верхушки корня'),
    ('surgeon','A16.07.054','Установка дентального имплантата','Dental implantat oʻrnatish',6500000,'tooth',90,true,'Имплантация'),
    ('surgeon','A16.07.026','Иссечение капюшона','Kapyushonni kesib olish',500000,'tooth',30,true,'Иссечение капюшона'),
    ('surgeon','A16.07.058','Наложение швов','Choklar qoʻyish',150000,'session',15,true,'Наложение швов'),

    ('orthopedist','B01.066.001','Приём врача-стоматолога-ортопеда первичный','Ortoped stomatolog birlamchi qabuli',350000,'session',20,true,'Приём ортопеда'),
    ('orthopedist','A02.07.010','Снятие оттиска двухслойного','Ikki qatlamli ottisk olish',350000,'jaw',30,true,'Оттиск двухслойный'),
    ('orthopedist','A16.07.023','Коронка временная','Vaqtinchalik toj',400000,'tooth',40,true,'Временная коронка'),
    ('orthopedist','A16.07.004.001','Коронка металлокерамическая','Metallokeramik toj',2200000,'tooth',60,true,'Металлокерамическая коронка'),
    ('orthopedist','A16.07.004.002','Коронка керамическая','Keramik toj',4500000,'tooth',60,true,'Керамическая коронка'),
    ('orthopedist','A16.07.003','Вкладка культевая штифтовая','Kultevoy shtift qoplamasi',1200000,'tooth',60,true,'Культевая вкладка'),
    ('orthopedist','A16.07.053','Фиксация коронки на постоянный цемент','Tojni doimiy sementga fiksatsiya',250000,'tooth',30,true,'Фиксация коронки'),
    ('orthopedist','A16.07.036','Протез съёмный частичный','Qisman olinadigan protez',4000000,'jaw',60,true,'Съёмный протез'),

    ('orthodontist','B01.063.001','Приём врача-ортодонта первичный','Ortodont birlamchi qabuli',350000,'session',20,true,'Приём ортодонта'),
    ('orthodontist','A02.07.006','Снятие оттиска альгинатного','Alginat ottisk olish',300000,'jaw',30,true,'Оттиск альгинатный'),
    ('orthodontist','A16.07.048','Фиксация брекет-системы металлической','Metall breket tizimini fiksatsiya',6000000,'jaw',90,true,'Брекеты металлические'),
    ('orthodontist','A16.07.048.001','Фиксация брекет-системы керамической','Keramik breket tizimini fiksatsiya',9000000,'jaw',90,true,'Брекеты керамические'),
    ('orthodontist','A16.07.047','Коррекция брекет-системы','Breket tizimini korreksiya',400000,'session',30,true,'Коррекция брекетов'),
    ('orthodontist','A16.07.047.001','Снятие брекет-системы','Breket tizimini olib tashlash',900000,'jaw',60,true,'Снятие брекетов'),
    ('orthodontist','A16.07.055','Изготовление и фиксация ретейнера','Reteyner tayyorlash va fiksatsiya',1200000,'jaw',45,true,'Ретейнер'),

    ('pediatric','B01.064.003','Приём детского стоматолога первичный','Bolalar stomatologi birlamchi qabuli',300000,'session',20,true,'Приём детского врача'),
    ('pediatric','A16.07.057','Герметизация фиссур','Fissuralarni germetizatsiya',350000,'tooth',25,true,'Герметизация фиссур'),
    ('pediatric','A16.07.002.012','Пломба молочного зуба стеклоиономером','Sut tishiga shisha ionomer plomba',450000,'tooth',30,true,'Пломба СИЦ'),
    ('pediatric','A16.07.002.013','Пломба молочного зуба композитом','Sut tishiga kompozit plomba',600000,'surface',35,true,'Пломба композитом (дети)'),
    ('pediatric','A16.07.001.003','Удаление молочного зуба','Sut tishini olib tashlash',300000,'tooth',20,true,'Удаление молочного зуба'),
    ('pediatric','A16.07.008.003','Пульпотомия молочного зуба','Sut tishi pulpotomiyasi',700000,'tooth',45,true,'Пульпотомия'),
    ('pediatric','A11.07.012','Аппликация фторлака','Ftorlak applikatsiyasi',200000,'jaw',15,true,'Фторлак'),
    ('pediatric','A16.07.031','Серебрение зубов','Tishlarni kumushlash',250000,'jaw',20,true,'Серебрение'),

    ('periodontist','B01.065.008','Приём врача-пародонтолога первичный','Parodontolog birlamchi qabuli',350000,'session',20,true,'Приём пародонтолога'),
    ('periodontist','A16.07.051.001','Профессиональная гигиена при пародонтите','Parodontitda professional gigiyena',600000,'jaw',60,true,'Гигиена при пародонтите'),
    ('periodontist','A16.07.020.001','Кюретаж закрытый','Yopiq kyuretaj',800000,'jaw',60,true,'Кюретаж закрытый'),
    ('periodontist','A16.07.020.002','Кюретаж открытый (лоскутная операция)','Ochiq kyuretaj',2500000,'jaw',90,true,'Кюретаж открытый'),
    ('periodontist','A16.07.038','Шинирование зубов стекловолокном','Tishlarni shishatola bilan shinalash',1800000,'jaw',90,true,'Шинирование'),
    ('periodontist','A11.07.010','Введение лекарства в пародонтальный карман','Parodontal choʻntakka dori kiritish',250000,'tooth',20,true,'Лекарство в карман')
  ) as v(tpl, code, ru, uz, price, unit, mins, book, tc) on v.tpl = n.code
 where not exists (select 1 from template_services x
                    where x.template_id = n.id and x.code = v.code);

-- ── Техкарты: блоки ───────────────────────────────────────────────────────

insert into template_techcard_lines (service_id, block_code, scales_with_quantity)
select s.id, v.blk, true
  from catalog_templates n
  join template_services s on s.template_id = n.id
  join (values
    ('B01.067.001','base'),
    ('A16.07.001.001','base'), ('A16.07.001.001','anesthesia'),
    ('A16.07.001.002','base'), ('A16.07.001.002','anesthesia'),
    ('A16.07.024','base'), ('A16.07.024','anesthesia'), ('A16.07.024','xray'),
    ('A16.07.007','base'), ('A16.07.007','anesthesia'), ('A16.07.007','xray'),
    ('A16.07.054','base'), ('A16.07.054','anesthesia'), ('A16.07.054','xray'),
    ('A16.07.026','base'), ('A16.07.026','anesthesia'),
    ('A16.07.058','base'),
    ('B01.066.001','base'),
    ('A02.07.010','base'),
    ('A16.07.023','base'), ('A16.07.023','anesthesia'),
    ('A16.07.004.001','base'), ('A16.07.004.001','anesthesia'),
    ('A16.07.004.002','base'), ('A16.07.004.002','anesthesia'),
    ('A16.07.003','base'), ('A16.07.003','anesthesia'), ('A16.07.003','xray'),
    ('A16.07.053','base'),
    ('A16.07.036','base'),
    ('B01.063.001','base'),
    ('A02.07.006','base'),
    ('A16.07.048','base'), ('A16.07.048.001','base'),
    ('A16.07.047','base'), ('A16.07.047.001','base'), ('A16.07.055','base'),
    ('B01.064.003','base'),
    ('A16.07.057','base'), ('A16.07.057','isolation'),
    ('A16.07.002.012','base'), ('A16.07.002.012','anesthesia'),
    ('A16.07.002.013','base'), ('A16.07.002.013','anesthesia'), ('A16.07.002.013','isolation'),
    ('A16.07.001.003','base'), ('A16.07.001.003','anesthesia'),
    ('A16.07.008.003','base'), ('A16.07.008.003','anesthesia'), ('A16.07.008.003','isolation'),
    ('A11.07.012','base'), ('A16.07.031','base'),
    ('B01.065.008','base'),
    ('A16.07.051.001','base'),
    ('A16.07.020.001','base'), ('A16.07.020.001','anesthesia'),
    ('A16.07.020.002','base'), ('A16.07.020.002','anesthesia'),
    ('A16.07.038','base'), ('A16.07.038','isolation'),
    ('A11.07.010','base')
  ) as v(code, blk) on v.code = s.code
 where not exists (select 1 from template_techcard_lines x
                    where x.service_id = s.id and x.block_code = v.blk);

-- ── Техкарты: материалы ───────────────────────────────────────────────────

insert into template_techcard_lines (service_id, material_name, norm_qty, unit_code, scales_with_quantity)
select s.id, v.m, v.q, v.u, true
  from catalog_templates n
  join template_services s on s.template_id = n.id
  join (values
    -- Хирург
    ('A16.07.001.001','Перчатки стерильные хирургические',1,'pair'),
    ('A16.07.001.001','Губка гемостатическая',0.3,'pc'),
    ('A16.07.001.001','Шприц 5 мл',1,'pc'),
    ('A16.07.001.001','Физраствор 0.9%',20,'ml'),
    ('A16.07.001.002','Перчатки стерильные хирургические',1,'pair'),
    ('A16.07.001.002','Скальпель одноразовый',1,'pc'),
    ('A16.07.001.002','Шовный материал',1,'pc'),
    ('A16.07.001.002','Бор хирургический',0.3,'pc_wear'),
    ('A16.07.001.002','Губка гемостатическая',1,'pc'),
    ('A16.07.001.002','Физраствор 0.9%',50,'ml'),
    ('A16.07.024','Перчатки стерильные хирургические',1,'pair'),
    ('A16.07.024','Простыня стерильная',1,'pc'),
    ('A16.07.024','Скальпель одноразовый',1,'pc'),
    ('A16.07.024','Шовный материал',2,'pc'),
    ('A16.07.024','Бор хирургический',0.6,'pc_wear'),
    ('A16.07.024','Губка гемостатическая',1,'pc'),
    ('A16.07.024','Физраствор 0.9%',100,'ml'),
    ('A16.07.007','Перчатки стерильные хирургические',1,'pair'),
    ('A16.07.007','Простыня стерильная',1,'pc'),
    ('A16.07.007','Скальпель одноразовый',1,'pc'),
    ('A16.07.007','Шовный материал',2,'pc'),
    ('A16.07.007','Бор хирургический',0.5,'pc_wear'),
    ('A16.07.007','Костный материал',0.25,'g'),
    ('A16.07.007','Мембрана коллагеновая',0.5,'pc'),
    ('A16.07.007','Физраствор 0.9%',100,'ml'),
    ('A16.07.054','Перчатки стерильные хирургические',2,'pair'),
    ('A16.07.054','Простыня стерильная',1,'pc'),
    ('A16.07.054','Имплантат дентальный',1,'pc'),
    ('A16.07.054','Формирователь десны',1,'pc'),
    ('A16.07.054','Фреза имплантологическая',0.1,'pc_wear'),
    ('A16.07.054','Шовный материал',1,'pc'),
    ('A16.07.054','Физраствор 0.9%',100,'ml'),
    ('A16.07.026','Скальпель одноразовый',1,'pc'),
    ('A16.07.026','Губка гемостатическая',0.3,'pc'),
    ('A16.07.058','Шовный материал',1,'pc'),
    -- Ортопед
    ('A02.07.010','Масса оттискная базовая',60,'g'),
    ('A02.07.010','Масса оттискная корригирующая',8,'ml'),
    ('A02.07.010','Ложка оттискная одноразовая',1,'pc'),
    ('A02.07.010','Гипс стоматологический IV класса',120,'g'),
    ('A02.07.010','Нить ретракционная',0.05,'m'),
    ('A16.07.023','Пластмасса для временных коронок',3,'g'),
    ('A16.07.023','Цемент временный',0.3,'g'),
    ('A16.07.023','Бор алмазный турбинный',0.3,'pc_wear'),
    ('A16.07.023','Диск полировальный',0.5,'pc_wear'),
    ('A16.07.023','Бумага артикуляционная',1,'pc'),
    ('A16.07.004.001','Коронка металлокерамическая (лаборатория)',1,'pc'),
    ('A16.07.004.001','Бор алмазный турбинный',0.6,'pc_wear'),
    ('A16.07.004.001','Нить ретракционная',0.05,'m'),
    ('A16.07.004.001','Цемент фиксирующий стеклоиономерный',0.2,'g'),
    ('A16.07.004.001','Бумага артикуляционная',1,'pc'),
    ('A16.07.004.002','Коронка керамическая (лаборатория)',1,'pc'),
    ('A16.07.004.002','Бор алмазный турбинный',0.6,'pc_wear'),
    ('A16.07.004.002','Нить ретракционная',0.05,'m'),
    ('A16.07.004.002','Цемент фиксирующий стеклоиономерный',0.2,'g'),
    ('A16.07.004.002','Бумага артикуляционная',1,'pc'),
    ('A16.07.003','Вкладка культевая (лаборатория)',1,'pc'),
    ('A16.07.003','Бор алмазный турбинный',0.4,'pc_wear'),
    ('A16.07.003','Цемент фиксирующий стеклоиономерный',0.2,'g'),
    ('A16.07.053','Цемент фиксирующий стеклоиономерный',0.2,'g'),
    ('A16.07.053','Бумага артикуляционная',1,'pc'),
    ('A16.07.036','Протез съёмный (лаборатория)',1,'pc'),
    ('A16.07.036','Масса оттискная базовая',80,'g'),
    ('A16.07.036','Ложка оттискная одноразовая',1,'pc'),
    ('A16.07.036','Гипс стоматологический IV класса',200,'g'),
    ('A16.07.036','Воск базисный',20,'g'),
    -- Ортодонт
    ('A02.07.006','Масса оттискная альгинатная',60,'g'),
    ('A02.07.006','Ложка оттискная одноразовая',1,'pc'),
    ('A16.07.048','Брекет металлический',10,'pc'),
    ('A16.07.048','Дуга ортодонтическая NiTi',1,'pc'),
    ('A16.07.048','Лигатура эластичная',10,'pc'),
    ('A16.07.048','Адгезив ортодонтический',0.5,'g'),
    ('A16.07.048','Праймер ортодонтический',0.3,'ml'),
    ('A16.07.048','Гель протравочный 37%',0.5,'ml'),
    ('A16.07.048','Аппликатор-кисточка',2,'pc'),
    ('A16.07.048.001','Брекет керамический',10,'pc'),
    ('A16.07.048.001','Дуга ортодонтическая NiTi',1,'pc'),
    ('A16.07.048.001','Лигатура эластичная',10,'pc'),
    ('A16.07.048.001','Адгезив ортодонтический',0.5,'g'),
    ('A16.07.048.001','Праймер ортодонтический',0.3,'ml'),
    ('A16.07.048.001','Гель протравочный 37%',0.5,'ml'),
    ('A16.07.048.001','Аппликатор-кисточка',2,'pc'),
    ('A16.07.047','Лигатура эластичная',10,'pc'),
    ('A16.07.047','Дуга ортодонтическая NiTi',0.5,'pc'),
    ('A16.07.047.001','Бор твердосплавный финишный',0.5,'pc_wear'),
    ('A16.07.047.001','Бор алмазный турбинный',0.3,'pc_wear'),
    ('A16.07.047.001','Паста полировальная',1,'g'),
    ('A16.07.047.001','Щётка полировальная',1,'pc'),
    ('A16.07.055','Проволока ретенционная',0.05,'m'),
    ('A16.07.055','Адгезив ортодонтический',0.2,'g'),
    ('A16.07.055','Гель протравочный 37%',0.2,'ml'),
    ('A16.07.055','Аппликатор-кисточка',2,'pc'),
    -- Детский
    ('A16.07.057','Силант для фиссур',0.1,'g'),
    ('A16.07.057','Гель протравочный 37%',0.2,'ml'),
    ('A16.07.057','Аппликатор-кисточка',1,'pc'),
    ('A16.07.057','Бор алмазный турбинный',0.1,'pc_wear'),
    ('A16.07.002.012','Цемент стеклоиономерный пломбировочный',0.3,'g'),
    ('A16.07.002.012','Бор алмазный турбинный',0.3,'pc_wear'),
    ('A16.07.002.012','Бумага артикуляционная',1,'pc'),
    ('A16.07.002.013','Адгезив',0.1,'ml'),
    ('A16.07.002.013','Гель протравочный 37%',0.2,'ml'),
    ('A16.07.002.013','Аппликатор-кисточка',2,'pc'),
    ('A16.07.002.013','Композит текучий',0.1,'g'),
    ('A16.07.002.013','Бор алмазный турбинный',0.3,'pc_wear'),
    ('A16.07.002.013','Диск полировальный',0.5,'pc_wear'),
    ('A16.07.002.013','Бумага артикуляционная',1,'pc'),
    ('A16.07.008.003','Паста для пульпотомии',0.1,'g'),
    ('A16.07.008.003','Цемент стеклоиономерный пломбировочный',0.3,'g'),
    ('A16.07.008.003','Бор алмазный турбинный',0.3,'pc_wear'),
    ('A11.07.012','Фторлак',0.5,'ml'),
    ('A11.07.012','Аппликатор-кисточка',2,'pc'),
    ('A16.07.031','Фторид диамина серебра',0.3,'ml'),
    ('A16.07.031','Аппликатор-кисточка',2,'pc'),
    -- Пародонтолог
    ('A16.07.051.001','Насадка скалера',0.08,'pc_wear'),
    ('A16.07.051.001','Кюрета Грейси',0.05,'pc_wear'),
    ('A16.07.051.001','Порошок Air Flow',20,'g'),
    ('A16.07.051.001','Паста полировальная',2,'g'),
    ('A16.07.051.001','Щётка полировальная',1,'pc'),
    ('A16.07.020.001','Кюрета Грейси',0.1,'pc_wear'),
    ('A16.07.020.001','Насадка скалера',0.05,'pc_wear'),
    ('A16.07.020.001','Гель для пародонтального кармана',0.3,'g'),
    ('A16.07.020.002','Скальпель одноразовый',1,'pc'),
    ('A16.07.020.002','Шовный материал',2,'pc'),
    ('A16.07.020.002','Кюрета Грейси',0.15,'pc_wear'),
    ('A16.07.020.002','Гель для пародонтального кармана',0.5,'g'),
    ('A16.07.038','Лента стекловолоконная',0.06,'m'),
    ('A16.07.038','Композит текучий',0.4,'g'),
    ('A16.07.038','Адгезив',0.2,'ml'),
    ('A16.07.038','Гель протравочный 37%',0.4,'ml'),
    ('A16.07.038','Аппликатор-кисточка',3,'pc'),
    ('A16.07.038','Бор алмазный турбинный',0.2,'pc_wear'),
    ('A11.07.010','Гель для пародонтального кармана',0.2,'g')
  ) as v(code, m, q, u) on v.code = s.code
 where exists (select 1 from template_materials tm
                where tm.template_id = n.id and tm.name_ru = v.m)
   and not exists (select 1 from template_techcard_lines x
                    where x.service_id = s.id and x.material_name = v.m);

-- Детский пломбирует композитом из группы взаимозаменяемых: списывается то,
-- что лежит на складе, а не то, что записано в техкарту.
insert into template_techcard_lines (service_id, analog_group_name, norm_qty, unit_code, scales_with_quantity)
select s.id, 'Композит пломбировочный', 0.2, 'g', true
  from catalog_templates n
  join template_services s on s.template_id = n.id and s.code = 'A16.07.002.013'
 where n.code = 'pediatric'
   and not exists (select 1 from template_techcard_lines x
                    where x.service_id = s.id and x.analog_group_name is not null);

/**
 * Проверка справочников. Была прибита к терапевту гвоздями; теперь смотрит
 * все — иначе новый справочник мог бы уехать в бой с осиротевшей строкой,
 * и никто бы не заметил.
 */
create or replace function public.template_health()
returns jsonb
language sql stable security definer set search_path to 'public','extensions' as $$
  select jsonb_object_agg(t.code, jsonb_build_object(
    'units',     (select count(*) from template_units where template_id = t.id),
    'materials', (select count(*) from template_materials where template_id = t.id),
    'services',  (select count(*) from template_services where template_id = t.id),
    'blocks',    (select count(*) from template_blocks where template_id = t.id),
    'materials_without_price',
      (select count(*) from template_materials
        where template_id = t.id and reference_price is null),
    'services_without_techcard',
      (select count(*) from template_services
        where template_id = t.id and techcard_name_ru is null),
    'services_without_lines',
      (select count(*) from template_services s
        where s.template_id = t.id
          and not exists (select 1 from template_techcard_lines l where l.service_id = s.id)),
    'orphan_lines', (
      select count(*) from template_techcard_lines l
        join template_services s on s.id = l.service_id and s.template_id = t.id
       where (l.material_name is not null and not exists (
               select 1 from template_materials m
                where m.template_id = t.id and m.name_ru = l.material_name))
          or (l.analog_group_name is not null and not exists (
               select 1 from template_analog_groups g
                where g.template_id = t.id and g.name = l.analog_group_name))
          or (l.block_code is not null and not exists (
               select 1 from template_blocks b
                where b.template_id = t.id and b.code = l.block_code))
          or (l.unit_code is not null and not exists (
               select 1 from template_units u
                where u.template_id = t.id and u.code = l.unit_code)))
  ))
  from catalog_templates t where t.is_active;
$$;

revoke all on function public.template_health() from public, anon, authenticated;

/**
 * Порядок справочников. Алфавитный ставил первым «Детского стоматолога», и
 * он же оказывался выбранным по умолчанию — а самый общий старт всё-таки
 * терапевтический. Порядок теперь тот же, что у специализаций.
 */
create or replace function public.available_templates()
returns table (code text, name_ru text, specialty text)
language sql stable security definer set search_path to 'public','extensions' as $$
  select t.code, t.name_ru, t.specialty
    from catalog_templates t
    left join specialties s on s.code = t.specialty
   where t.is_active
   order by coalesce(s.position, 1000), t.name_ru;
$$;

revoke all on function public.available_templates() from public, anon, authenticated;

-- Справочник специализаций общий и на чтение никому снаружи не нужен:
-- приложение получает его функцией под service_role. RLS без единой политики
-- читается как «забыли написать» — пишем явный запрет, чтобы намерение было
-- видно и в схеме, и в проверке готовности.
drop policy if exists specialties_deny_anon on specialties;
drop policy if exists specialties_deny_authenticated on specialties;

create policy specialties_deny_anon on specialties
  as restrictive for all to anon using (false) with check (false);

create policy specialties_deny_authenticated on specialties
  as restrictive for all to authenticated using (false) with check (false);
