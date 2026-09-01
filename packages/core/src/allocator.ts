import { batchLineCost, ceilToWholeUnit, floorToWholeUnit } from './numeric.js';
import type { Qty } from './numeric.js';
import type {
  Allocation,
  CandidateBatch,
  Consumption,
  ExpandedLine,
  Requirement,
  Shortfall,
} from './types.js';

/**
 * Аллокатор FEFO — чистая функция без обращений к БД.
 *
 * Вариант A′: закрытие приёма никогда не отвергается по причине остатка. Непокрытая
 * потребность становится строкой недостачи, а не ошибкой, — иначе врач, у которого
 * материал физически израсходован, не может закрыть приём и склад расходится сильнее.
 */

/**
 * Разворот строк снимка в потребности. Порядок операций — правило 4 контракта округления:
 * конвертация (уже сделана при построении снимка) → умножение на quantity → округление вверх.
 */
export function buildRequirements(lines: readonly ExpandedLine[], quantity: number): Requirement[] {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error(`quantity должен быть целым ≥ 1, получено ${quantity}`);
  }
  return lines.map((line) => {
    const multiplier = line.scalesWithQuantity ? BigInt(quantity) : 1n;
    const scaled = line.normQty * multiplier;
    // Округление вверх — один раз, после умножения. Иначе 3 × ⌈0.6⌉ = 3 вместо ⌈1.8⌉ = 2.
    const requiredQty = line.divisible ? scaled : ceilToWholeUnit(scaled);
    const materialIds =
      line.materialId !== null ? [line.materialId] : [...line.analogMaterialIds];
    if (materialIds.length === 0) {
      throw new Error(`строка ${line.lineId} не имеет ни материала, ни состава группы аналогов`);
    }
    return { lineId: line.lineId, materialIds, requiredQty, divisible: line.divisible };
  });
}

function isExpired(batch: CandidateBatch, visitDate: string): boolean {
  return batch.expiresAt !== null && batch.expiresAt < visitDate;
}

/** FEFO: ближайший срок первым; бессрочные — в конец; `batchId` как детерминированный тайбрейк. */
function byFefo(a: CandidateBatch, b: CandidateBatch): number {
  if (a.expiresAt !== b.expiresAt) {
    if (a.expiresAt === null) return 1;
    if (b.expiresAt === null) return -1;
    return a.expiresAt < b.expiresAt ? -1 : 1;
  }
  return a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0;
}

/** Сколько реально можно взять из партии: у неделимого материала остаток отбрасывается до целого. */
function usableRemaining(remaining: Qty, divisible: boolean): Qty {
  return divisible ? remaining : floorToWholeUnit(remaining);
}

/**
 * Последняя известная закупочная цена материала — четвёртое звено контракта цены,
 * до справочной цены библиотеки. Берётся как цена за одну базовую единицу из самой
 * свежей партии этого материала, у которой цена известна.
 */
function lastKnownUnitPrice(
  materialId: string,
  batches: readonly CandidateBatch[],
): { totalPrice: bigint; initialQty: Qty } | null {
  const priced = batches
    .filter((b) => b.materialId === materialId && b.totalPrice !== null && b.initialQty > 0n)
    .sort(byFefo);
  const latest = priced[priced.length - 1];
  return latest === undefined
    ? null
    : { totalPrice: latest.totalPrice as bigint, initialQty: latest.initialQty };
}

export function allocate(args: {
  requirements: readonly Requirement[];
  batches: readonly CandidateBatch[];
  /** Дата приёма в формате YYYY-MM-DD — по ней отсекаются просроченные партии. */
  visitDate: string;
}): Allocation {
  const { requirements, batches, visitDate } = args;

  const fresh = batches.filter((b) => !isExpired(b, visitDate)).sort(byFefo);
  // Расход в рамках одного закрытия накапливается: две строки могут брать из одной партии.
  const takenFromBatch = new Map<string, Qty>();
  const remainingOf = (b: CandidateBatch): Qty => b.qtyRemaining - (takenFromBatch.get(b.batchId) ?? 0n);

  const consumptions: Consumption[] = [];
  const shortfalls: Shortfall[] = [];
  let materialsTotal = 0n;
  let unpricedLinesCount = 0;

  for (const req of requirements) {
    let outstanding = req.requiredQty;
    if (outstanding <= 0n) continue;

    // Смешивание аналогов внутри строки запрещено: следующий материал группы берётся
    // только когда предыдущий исчерпан целиком. Внутри одного материала партии
    // расходуются по FEFO — это не смешивание, а нормальная работа склада.
    for (const materialId of req.materialIds) {
      if (outstanding <= 0n) break;
      for (const batch of fresh.filter((b) => b.materialId === materialId)) {
        if (outstanding <= 0n) break;
        const available = usableRemaining(remainingOf(batch), req.divisible);
        if (available <= 0n) continue;

        let take = available < outstanding ? available : outstanding;
        // Неделимая единица не дробится между партиями: берём только целые единицы.
        if (!req.divisible) take = floorToWholeUnit(take);
        if (take <= 0n) continue;

        const consumedBefore = batch.initialQty - remainingOf(batch);
        const cost = batchLineCost({
          batchTotalPrice: batch.totalPrice,
          initialQty: batch.initialQty,
          consumedBefore,
          taken: take,
        });

        consumptions.push({
          lineId: req.lineId,
          batchId: batch.batchId,
          materialId: batch.materialId,
          qty: take,
          cost,
          unpriced: cost === null,
          expectedQtyRemaining: batch.qtyRemaining,
        });
        if (cost === null) unpricedLinesCount += 1;
        else materialsTotal += cost;

        takenFromBatch.set(batch.batchId, (takenFromBatch.get(batch.batchId) ?? 0n) + take);
        outstanding -= take;
      }
    }

    if (outstanding > 0n) {
      // Недостача оценивается по последней известной цене материала. Ноль как заглушка
      // запрещён: он превратил бы маржу в 100% и соврал бы в главном отчёте продукта.
      const materialId = req.materialIds[0] as string;
      const priceRef = lastKnownUnitPrice(materialId, batches);
      const cost =
        priceRef === null
          ? null
          : batchLineCost({
              batchTotalPrice: priceRef.totalPrice,
              initialQty: priceRef.initialQty,
              consumedBefore: 0n,
              taken: outstanding,
            });
      shortfalls.push({
        lineId: req.lineId,
        materialId,
        qty: outstanding,
        cost,
        unpriced: cost === null,
      });
      if (cost === null) unpricedLinesCount += 1;
      else materialsTotal += cost;
    }
  }

  return {
    consumptions,
    shortfalls,
    materialsTotal,
    hasUnpriced: unpricedLinesCount > 0,
    unpricedLinesCount,
  };
}
