-- 060_real_prices_and_payment_probe

-- Цены были заглушками: 200 000 сум и 1000 звёзд я поставил, чтобы механизм
-- было на чём проверить, а не потому что столько стоит.
--
-- Месяц — 50 000 сум: это число назвал владелец, и оно ниже конкурента
-- (60 000 за врача у Stomcat). Полгода и год — та же цена со скидкой 10% и
-- 20%: длинный срок дешевле, потому что снимает отток и предоплачивает
-- работу вперёд.
--
-- Звёзды НЕ пересчитаны из сумов курсом. Telegram берёт свою долю, а магазины
-- Apple и Google — свою поверх, поэтому «столько же, сколько в сумах» в
-- звёздах не получается: врач заплатит заметно больше, чем придёт нам.
-- Числа ниже — рабочая заготовка одного порядка с суммой в сумах; итоговые
-- назначает владелец, сверив их с тем, что реально приходит на счёт.
update subscription_plans set price_uzs =  50000, price_stars =  400 where code = 'monthly';
update subscription_plans set price_uzs = 270000, price_stars = 2160 where code = 'halfyear';
update subscription_plans set price_uzs = 480000, price_stars = 3840 where code = 'year';

-- Проверочный план на одну звезду.
--
-- Полный путь платежа — счёт, подтверждение, зачисление — нельзя доказать
-- иначе как настоящей покупкой: pre_checkout_query и successful_payment
-- присылает Telegram, и подделать их значит проверить свою же подделку.
-- Одна звезда стоит около двух центов, и этого хватает, чтобы пройти путь
-- целиком. После проверки план выключается.
insert into subscription_plans (code, name_ru, months, price_uzs, price_stars, is_active)
values ('probe', 'Проверка оплаты — 1 звезда', 1, 1, 1, true)
on conflict (code) do update
   set name_ru = excluded.name_ru, months = excluded.months,
       price_uzs = excluded.price_uzs, price_stars = excluded.price_stars,
       is_active = true;
