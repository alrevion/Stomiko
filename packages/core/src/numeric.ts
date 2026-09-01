/**
 * Точная арифметика без float.
 *
 * В БД количества — numeric(18,6), деньги — numeric(18,2), а строки движений
 * хранятся неокруглёнными с 6 знаками. PostgREST отдаёт numeric строкой, поэтому
 * весь расчёт идёт в bigint микро-единицах (10^-6), и ни одно значение по пути
 * не превращается в Number.
 */

/** Количество в микро-единицах базовой единицы измерения (10^-6). */
export type Qty = bigint;
/** Деньги в микро-суммах (10^-6 сума). Округление до тийинов — только в visit_costs. */
export type Money = bigint;

export const SCALE = 6;
const SCALE_FACTOR = 1_000_000n;

/** numeric-строка из Postgres → bigint микро-единиц. Дробная часть длиннее 6 знаков запрещена. */
export function parseNumeric(value: string): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`не numeric: ${value}`);
  }
  const negative = trimmed.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? trimmed.slice(1) : trimmed).split('.');
  if (fraction.length > SCALE) {
    throw new Error(`точность выше ${SCALE} знаков потерялась бы: ${value}`);
  }
  const scaled = BigInt(whole) * SCALE_FACTOR + BigInt(fraction.padEnd(SCALE, '0') || '0');
  return negative ? -scaled : scaled;
}

/** bigint микро-единиц → numeric-строка для записи в Postgres. */
export function formatNumeric(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / SCALE_FACTOR;
  const fraction = (abs % SCALE_FACTOR).toString().padStart(SCALE, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** Целое число базовых единиц → микро-единицы. */
export function fromWhole(units: number | bigint): bigint {
  return BigInt(units) * SCALE_FACTOR;
}

/**
 * Деление вниз, корректное для отрицательных значений.
 * Штатное деление bigint в JS усекает к нулю, что для отрицательных ломает
 * монотонность накопительного флоринга в контракте округления.
 */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error('деление на ноль');
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

/** Округление вверх до целой базовой единицы. Правило 5 контракта округления. */
export function ceilToWholeUnit(qty: Qty): Qty {
  if (qty <= 0n) return 0n;
  const remainder = qty % SCALE_FACTOR;
  return remainder === 0n ? qty : qty + (SCALE_FACTOR - remainder);
}

/** Округление вниз до целой базовой единицы — для остатка неделимого материала на партии. */
export function floorToWholeUnit(qty: Qty): Qty {
  if (qty <= 0n) return 0n;
  return qty - (qty % SCALE_FACTOR);
}

/**
 * Стоимость взятого из партии — правила 1 и 2 контракта округления.
 *
 * Считается через долю партии, а НЕ через удельную цену: партия 100 000 сум за 3 г
 * даёт удельную 33 333.333333, и три списания по 1 г дали бы 99 999.999999.
 *
 * Накопительный флоринг гарантирует, что сумма стоимостей всех списаний по партии
 * равна её цене ровно, а неразнесённая дробь автоматически достаётся списанию,
 * исчерпывающему партию (largest-remainder во втором измерении).
 */
export function batchLineCost(args: {
  /** Цена всей партии. `null` — цена неизвестна, строка помечается unpriced. */
  batchTotalPrice: Money | null;
  /** Исходное количество партии. */
  initialQty: Qty;
  /** Сколько уже израсходовано до этого списания. */
  consumedBefore: Qty;
  /** Сколько берём сейчас. */
  taken: Qty;
}): Money | null {
  const { batchTotalPrice, initialQty, consumedBefore, taken } = args;
  if (batchTotalPrice === null) return null;
  if (initialQty <= 0n) throw new Error('initialQty партии должен быть положительным');
  const before = floorDiv(batchTotalPrice * consumedBefore, initialQty);
  const after = floorDiv(batchTotalPrice * (consumedBefore + taken), initialQty);
  return after - before;
}

/** Округление микро-суммы до тийинов (2 знака) — единственная точка округления денег. */
export function roundToMinorUnits(value: Money): Money {
  const step = 10_000n; // 10^-2 в микро-суммах
  const remainder = ((value % step) + step) % step;
  return remainder * 2n >= step ? value + (step - remainder) : value - remainder;
}
