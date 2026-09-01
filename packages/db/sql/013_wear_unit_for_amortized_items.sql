-- 013_wear_unit_for_amortized_items (применена 20260825092838)

-- Износные позиции нормируются долями (бор служит ~3 процедуры → 0.3), но лежали
-- в единице 'шт' с divisible = false. Округление вверх списывало бы целый бор на
-- каждую пломбу — трёхкратное завышение себестоимости.
-- Делимость по смыслу принадлежит материалу, а не единице: карпулу вскрыл —
-- потратил целиком, бор амортизируется. Заводим отдельную делимую единицу.
do $$
declare t uuid; u_wear uuid; n int;
begin
  select id into t from tenants where name='Кабинет стоматолога-терапевта';

  insert into units (tenant_id, code, name_ru, name_uz, divisible)
    values (t,'pc_wear','шт (износ)','dona (yeyilish)',true)
    returning id into u_wear;

  update techcard_lines tl
     set unit_id = u_wear
    from materials m
   where m.id = tl.material_id
     and m.tenant_id = t
     and m.name_ru in (
       'Бор алмазный турбинный','Бор твердосплавный финишный','Кольцо матричное',
       'Диск полировальный','Файл ручной K-file','Файл NiTi ротационный','Насадка скалера'
     );

  update techcard_block_lines bl
     set unit_id = u_wear
    from materials m
   where m.id = bl.material_id
     and m.tenant_id = t
     and m.name_ru in ('Кламп','Держатель сенсора');

  -- Снимки пересобираются: они неизменяемы по смыслу, но здесь мы правим
  -- саму версию до того, как по ней прошёл хоть один закрытый приём.
  select count(*) into n from visit_costs;
  if n > 0 then
    raise exception 'есть закрытые приёмы — правка версии задним числом запрещена, нужна новая версия';
  end if;

  perform expand_techcard_version(tv.id) from techcard_versions tv;
end $$;

select m.name_ru, te.norm_qty, te.divisible, te.scales_with_quantity
  from techcard_expanded te
  join materials m on m.id = te.material_id
 where m.name_ru in ('Бор алмазный турбинный','Файл NiTi ротационный','Кламп','Карпула артикаин 4% 1:100000')
 group by 1,2,3,4 order by 1;;
