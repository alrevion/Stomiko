/**
 * Демо-сид: месяц работы кабинета терапевта.
 *
 * Гоняет приёмы через ПРОДОВЫЙ `closeVisit()` и приходует партии через продовый
 * `receiveBatch()`. Второго пути записи движений не существует — иначе сид
 * тестировал бы код, которого нет в проде, а расхождение всплыло бы у врача.
 *
 * Запуск: pnpm --filter @stomiko/api seed
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { closeVisit } from '../src/close.js';
import { TenantScope } from '../src/db.js';
import { receiveBatch } from '../src/stock.js';

const here = dirname(fileURLToPath(import.meta.url));

function loadEnv(): { url: string; key: string } {
  const raw = readFileSync(resolve(here, '../.dev.vars'), 'utf8');
  const vars = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx > 0) vars.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim());
  }
  const url = vars.get('SUPABASE_URL');
  const key = vars.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('в .dev.vars нет SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  return { url, key };
}

/** Детерминированный ГПСЧ: один и тот же сид даёт один и тот же месяц. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const FIRST = ['Санжар','Дилноза','Азиз','Малика','Тимур','Нигора','Рустам','Зухра','Бекзод','Феруза','Отабек','Камола','Жасур','Мохира','Улугбек','Севара'];
const LAST = ['Азизов','Каримова','Юсупов','Рахимова','Тошматов','Эргашева','Абдуллаев','Саидова','Нурматов','Хайдарова','Мирзаев','Юлдашева'];

/**
 * Реальная структура дня терапевта: чаще всего пломбы, реже эндодонтия,
 * гигиена и осмотры между ними. Веса подобраны так, чтобы отчёт маржи
 * выглядел как месяц работы, а не как равномерный шум.
 */
const MIX: { code: string; weight: number; qty: () => number }[] = [
  { code: 'B01.065.007',    weight: 14, qty: () => 1 },
  { code: 'A16.07.002.010', weight: 22, qty: () => 1 },
  { code: 'A16.07.002.011', weight: 20, qty: () => 1 },
  { code: 'A16.07.002.009', weight: 8,  qty: () => 1 },
  { code: 'A16.07.030.001', weight: 12, qty: () => 0 }, // каналы задаются ниже
  { code: 'A16.07.008.002', weight: 10, qty: () => 0 },
  { code: 'A16.07.051',     weight: 10, qty: () => 1 },
  { code: 'A06.07.003',     weight: 4,  qty: () => 1 },
];


/**
 * Опорный склад кабинета на месяц.
 *
 * Числа НЕ придуманы: это фактическое потребление 163 приёмов, снятое с первого
 * прогона сида, умноженное на 1.35 запаса. Ровно та отраслевая практика, по
 * которой нормы снимают наблюдением за работой, а не берут из справочника.
 * Первый прогон с догадками дал 944 строки недостачи и 29 высохших партий.
 */
const OPENING_STOCK: Record<string, number> = {
  'Адгезив': 21, 'Аппликатор-кисточка': 280, 'Бахилы': 300,
  'Бор алмазный турбинный': 42, 'Бор твердосплавный финишный': 28,
  'Бумага артикуляционная': 170, 'Валик ватный': 1215,
  'Гель аппликационный лидокаин 10%': 56, 'Гель протравочный 37%': 42,
  'Гипохлорит натрия 3%': 880, 'Дентин-паста временная': 32, 'Держатель сенсора': 4,
  'Диск полировальный': 70, 'Игла карпульная': 188, 'Индикатор стерилизации': 300,
  'Карпула артикаин 4% 1:100000': 188, 'Кламп': 5, 'Клин межзубный': 55,
  'Кольцо матричное': 3, 'Композит пломбировочный A': 35, 'Композит пломбировочный B': 9,
  'Композит текучий': 14, 'Коффердам лист': 210, 'Маска медицинская': 300,
  'Матрица секционная': 55, 'Микроаппликатор': 188, 'Насадка скалера': 2,
  'Паста гидроксид кальция': 18, 'Паста полировальная': 47, 'Перчатки нитриловые': 1215,
  'Порошок Air Flow': 466, 'Резинка полировальная': 31, 'Рулон для стерилизации': 91,
  'Салфетка дезинфицирующая': 608, 'Салфетка нагрудная': 300, 'Силер': 6,
  'Слюноотсос': 300, 'Средство для дезинфекции поверхностей': 3038,
  'Стакан одноразовый': 300, 'Таблетка-индикатор налёта': 31,
  'Файл NiTi ротационный': 29, 'Файл ручной K-file': 27, 'Флосс': 42, 'Фторлак': 16,
  'Хлоргексидин 0.05%': 4557, 'Чехол на подголовник': 300, 'Чехол на сенсор': 76,
  'Шприц эндодонтический с иглой': 88, 'Штифт бумажный': 453,
  'Штифт гуттаперчевый': 102, 'Штрипс полировальный': 141,
  'Щётка полировальная': 31, 'ЭДТА гель': 18,
};

async function main() {
  const { url, key } = loadEnv();
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: tenants, error: tErr } = await sb.from('tenants').select('id, name').limit(1);
  if (tErr || !tenants?.length) throw new Error(`нет кабинета: ${tErr?.message ?? 'пусто'}`);
  const tenantId = tenants[0]!.id as string;
  const scope = new TenantScope(sb, tenantId);
  console.log(`Кабинет: ${tenants[0]!.name}`);

  const { data: locations } = await sb.from('locations').select('id').eq('tenant_id', tenantId).limit(1);
  const locationId = locations![0]!.id as string;

  const { data: services } = await sb
    .from('services')
    .select('id, code, name_ru, price, unit_of_norm, techcard_version_id')
    .eq('tenant_id', tenantId);
  const byCode = new Map((services ?? []).map((s) => [s.code as string, s]));

  const { data: existing } = await sb
    .from('visits').select('id').eq('tenant_id', tenantId).eq('status', 'closed').limit(1);
  if (existing?.length) {
    console.log('В кабинете уже есть закрытые приёмы. Сид идемпотентен по факту: повтор не запускаем.');
    return;
  }

  const rand = rng(20260825);
  const today = new Date();
  const days: string[] = [];
  for (let i = 29; i >= 0; i -= 1) {
    const d = new Date(today.getTime() - i * 864e5);
    if (d.getDay() === 0) continue; // воскресенье кабинет не работает
    days.push(d.toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' }));
  }

  // Опорный склад: доводим каждый материал до месячной потребности с запасом.
  // Приход идёт через продовый receiveBatch — второго пути записи движений
  // не появляется даже ради демо.
  const { data: allMaterials } = await sb
    .from('materials').select('id, name_ru, reference_price').eq('tenant_id', tenantId);
  const { data: stockNow } = await sb
    .from('batches').select('material_id, qty_remaining').eq('tenant_id', tenantId);
  const haveByMaterial = new Map<string, number>();
  for (const b of stockNow ?? []) {
    haveByMaterial.set(
      String(b.material_id),
      (haveByMaterial.get(String(b.material_id)) ?? 0) + Number(b.qty_remaining),
    );
  }

  let toppedUp = 0;
  for (const m of allMaterials ?? []) {
    const target = OPENING_STOCK[m.name_ru as string];
    if (target === undefined) continue;
    const have = haveByMaterial.get(String(m.id)) ?? 0;
    const missing = target - have;
    if (missing <= 0) continue;
    await receiveBatch(scope, {
      locationId,
      materialId: m.id as string,
      qty: missing,
      totalPrice: Number(m.reference_price) * missing,
      expiresAt: new Date(today.getTime() + 400 * 864e5).toLocaleDateString('en-CA'),
      supplier: 'Закупка на месяц',
    });
    toppedUp += 1;
  }
  console.log(`Материалов дозакуплено до месячной потребности: ${toppedUp}`);

  // Дополнительные приходы внутри месяца: кабинет докупает ходовое по ходу дела.
  const { data: hotMaterials } = await sb
    .from('materials').select('id, name_ru, reference_price').eq('tenant_id', tenantId)
    .in('name_ru', ['Композит пломбировочный A','Гипохлорит натрия 3%','Карпула артикаин 4% 1:100000','Адгезив']);
  for (const [i, m] of (hotMaterials ?? []).entries()) {
    const qty = m.name_ru === 'Гипохлорит натрия 3%' ? 1500 : m.name_ru === 'Карпула артикаин 4% 1:100000' ? 100 : 10;
    await receiveBatch(scope, {
      locationId,
      materialId: m.id as string,
      qty,
      totalPrice: Number(m.reference_price) * qty,
      expiresAt: new Date(today.getTime() + (300 + i * 30) * 864e5).toLocaleDateString('en-CA'),
      supplier: 'Дозакупка в середине месяца',
    });
  }
  console.log(`Дозакупок: ${(hotMaterials ?? []).length}`);

  let closed = 0, failed = 0, shortfalls = 0, unpriced = 0;
  const totalWeight = MIX.reduce((s, m) => s + m.weight, 0);

  for (const day of days) {
    const visitsToday = 5 + Math.floor(rand() * 4); // 5–8 приёмов
    for (let i = 0; i < visitsToday; i += 1) {
      const name = `${LAST[Math.floor(rand() * LAST.length)]} ${FIRST[Math.floor(rand() * FIRST.length)]}`;

      const { data: patient } = await sb
        .from('patients').insert({ tenant_id: tenantId, full_name: name }).select('id').single();
      const { data: visit } = await sb
        .from('visits')
        .insert({ tenant_id: tenantId, location_id: locationId, patient_id: patient!.id, visit_date: day })
        .select('id').single();

      // 1–2 услуги на приём: реальный кабинет редко делает больше за один визит.
      const lines = 1 + (rand() < 0.35 ? 1 : 0);
      for (let l = 0; l < lines; l += 1) {
        let roll = rand() * totalWeight;
        const pick = MIX.find((m) => (roll -= m.weight) <= 0) ?? MIX[0]!;
        const svc = byCode.get(pick.code);
        if (!svc) continue;
        // Без техкарты приём закроется с нулевой себестоимостью и покажет
        // маржу 100% — при этом все инварианты сойдутся на нуле. Падаем громко.
        if (!svc.techcard_version_id) throw new Error(`у услуги ${pick.code} нет техкарты`);
        // Каналы: резцы — один, моляры — три. Это единица нормирования, не зубы.
        const qty = svc.unit_of_norm === 'canal' ? (rand() < 0.45 ? 3 : 1) : pick.qty() || 1;
        await sb.from('visit_services').insert({
          tenant_id: tenantId,
          visit_id: visit!.id,
          service_id: svc.id,
          quantity: qty,
          price: Number(svc.price) * qty,
          techcard_version_id: svc.techcard_version_id,
        });
      }

      try {
        const r = await closeVisit(scope, visit!.id as string);
        closed += 1;
        shortfalls += r.shortfalls;
        unpriced += r.unpricedLinesCount;
      } catch (err) {
        failed += 1;
        if (failed <= 3) console.error(`  сбой на ${day}: ${(err as Error).message}`);
      }
    }
    process.stdout.write(`\r${day}: закрыто ${closed}`);
  }

  console.log(`\n\nЗакрыто приёмов: ${closed}, сбоев: ${failed}`);
  console.log(`Строк недостачи: ${shortfalls}, строк без цены: ${unpriced}`);

  await assertDemoIsBelievable(sb, tenantId);
}

/**
 * Сид обязан уметь провалиться. Демо-кабинет с нулевой себестоимостью проходит
 * все инварианты (0 == 0) и показывает маржу 100% — то есть выглядит идеально
 * и врёт. Проверяем не «данные есть», а «данные правдоподобны».
 */
async function assertDemoIsBelievable(sb: ReturnType<typeof createClient>, tenantId: string) {
  const problems: string[] = [];

  const { data: costs } = await sb
    .from('visit_costs').select('materials_total, has_unpriced').eq('tenant_id', tenantId)
    .is('superseded_at', null);
  const totalCost = (costs ?? []).reduce((s, c) => s + Number(c.materials_total), 0);
  const unpricedVisits = (costs ?? []).filter((c) => c.has_unpriced).length;

  const { data: vs } = await sb.from('visit_services').select('price').eq('tenant_id', tenantId);
  const revenue = (vs ?? []).reduce((s, x) => s + Number(x.price), 0);

  const { data: consumes } = await sb
    .from('stock_movements').select('id').eq('tenant_id', tenantId).eq('kind', 'consume').limit(1);
  const { data: shortfallRows } = await sb
    .from('stock_movements').select('cost').eq('tenant_id', tenantId).eq('kind', 'shortfall');
  const shortfallCost = (shortfallRows ?? []).reduce((s, m) => s + Number(m.cost ?? 0), 0);

  const { data: batches } = await sb
    .from('batches').select('initial_qty, qty_remaining').eq('tenant_id', tenantId);
  const exhausted = (batches ?? []).filter((b) => Number(b.qty_remaining) === 0).length;
  const partial = (batches ?? []).filter(
    (b) => Number(b.qty_remaining) > 0 && Number(b.qty_remaining) < Number(b.initial_qty),
  ).length;

  const marginPct = revenue > 0 ? ((revenue - totalCost) / revenue) * 100 : 0;
  const shortfallShare = totalCost > 0 ? (shortfallCost / totalCost) * 100 : 0;

  if (!consumes?.length) problems.push('нет ни одного списания: техкарты не подтянулись');
  if (totalCost <= 0) problems.push('суммарная себестоимость равна нулю');
  if (marginPct < 40 || marginPct > 85) problems.push(`маржа ${marginPct.toFixed(1)}% вне диапазона 40–85%`);
  if (shortfallShare > 5) problems.push(`недостачи ${shortfallShare.toFixed(1)}% > 5%`);
  if (unpricedVisits > 0) problems.push(`${unpricedVisits} приёмов с неизвестной ценой`);
  if (partial < 1) problems.push('ни одна партия не израсходована частично: FEFO не ветвился');

  console.log('');
  console.log(`Выручка:        ${Math.round(revenue).toLocaleString('ru-RU')} сум`);
  console.log(`Себестоимость:  ${Math.round(totalCost).toLocaleString('ru-RU')} сум`);
  console.log(`Маржа:          ${Math.round(revenue - totalCost).toLocaleString('ru-RU')} сум (${marginPct.toFixed(1)}%)`);
  console.log(`Партий израсходовано полностью: ${exhausted}, частично: ${partial}`);

  if (problems.length) {
    console.error('\nДЕМО НЕПРАВДОПОДОБНО:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('\nДемо правдоподобно: все проверки пройдены.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
