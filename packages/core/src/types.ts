import type { Money, Qty } from './numeric.js';

/** Строка развёрнутого снимка техкарты (`techcard_expanded`). */
export interface ExpandedLine {
  lineId: string;
  /** Строка покрывается либо конкретным материалом, либо группой аналогов. */
  materialId: string | null;
  analogGroupId: string | null;
  /** Состав группы аналогов, зафиксированный в снимке. Порядок — приоритет врача. */
  analogMaterialIds: readonly string[];
  /** Норма расхода, уже сконвертированная в базовую единицу при развороте снимка. */
  normQty: Qty;
  /** Делимая ли базовая единица. Неделимая округляется вверх до целого. */
  divisible: boolean;
  /**
   * Масштабируется ли строка на `quantity` услуги.
   * Строки процедурной надстройки — `true`, строки блоков (базовый набор кресла,
   * анестезия, изоляция, рентген) — `false`: моляр с тремя каналами расходует втрое
   * больше гипохлорита, но одну пару перчаток и одну карпулу.
   */
  scalesWithQuantity: boolean;
}

/** Кандидатная партия из `get_close_context`. */
export interface CandidateBatch {
  batchId: string;
  materialId: string;
  /** Исходное количество партии — база для расчёта доли. */
  initialQty: Qty;
  /** Текущий остаток. Он же версия для оптимистической сверки в `apply_visit_close`. */
  qtyRemaining: Qty;
  /** Цена всей партии. `null` — неизвестна, движения по ней получат флаг unpriced. */
  totalPrice: Money | null;
  /** Срок годности. `null` — бессрочная. Просроченные в кандидаты не попадают. */
  expiresAt: string | null;
}

/** Потребность одной строки после масштабирования и округления. */
export interface Requirement {
  lineId: string;
  /** Материалы-кандидаты в порядке приоритета: один материал либо состав группы аналогов. */
  materialIds: readonly string[];
  requiredQty: Qty;
  divisible: boolean;
}

export interface Consumption {
  lineId: string;
  batchId: string;
  materialId: string;
  qty: Qty;
  /** `null` — цена партии неизвестна. Никогда не 0 как заглушка. */
  cost: Money | null;
  unpriced: boolean;
  /** Остаток партии до списания — версия для оптимистической сверки. */
  expectedQtyRemaining: Qty;
}

export interface Shortfall {
  lineId: string;
  materialId: string;
  qty: Qty;
  cost: Money | null;
  unpriced: boolean;
}

export interface Allocation {
  consumptions: Consumption[];
  shortfalls: Shortfall[];
  /** Сумма известных стоимостей. Строки без цены сюда не входят. */
  materialsTotal: Money;
  hasUnpriced: boolean;
  unpricedLinesCount: number;
}
