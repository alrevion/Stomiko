import type { TenantScope } from './db.js';

/**
 * Замкнутый набор складских операций.
 *
 * Ни один другой путь не имеет права трогать `stock_movements` и `batches`.
 * Всё, что мутирует склад, перечислено здесь поимённо — включая демо-сид:
 * второй путь записи движений не появляется даже ради заполнения демо-кабинета.
 */
export const STOCK_OPERATIONS = [
  'closeVisit',
  'reopenVisit',
  'receiveBatch',
  'adjustStock',
  'writeOffBatch',
  'acknowledgeShortfall',
] as const;

export interface ReceiveBatchInput {
  locationId: string;
  materialId: string;
  qty: number;
  /** `null` — цена неизвестна. Ноль как заглушка запрещён контрактом цены. */
  totalPrice: number | null;
  expiresAt: string | null;
  supplier?: string | undefined;
  /** Цена подставлена справочной из библиотеки, а не взята из накладной. */
  priceEstimated?: boolean | undefined;
}

/** Приход партии. Партия и движение пишутся одной транзакцией на стороне БД. */
export async function receiveBatch(scope: TenantScope, input: ReceiveBatchInput): Promise<string> {
  return scope.rpc<string>('receive_batch', {
    p_tenant_id: scope.tenantId,
    p_location_id: input.locationId,
    p_material_id: input.materialId,
    p_qty: input.qty,
    p_total_price: input.totalPrice,
    p_expires_at: input.expiresAt,
    p_supplier: input.supplier ?? null,
    p_price_estimated: input.priceEstimated ?? false,
  });
}

/**
 * Корректировка остатка после инвентаризации.
 *
 * Это не «кнопка списать» из потока врача: операция живёт на складском экране,
 * требует причины и не является условием закрытия приёма. Именно поэтому
 * вариант A′ вообще имеет право на существование — расхождение разбирается
 * отдельно от клинического факта.
 */
export async function adjustStock(
  scope: TenantScope,
  batchId: string,
  newQty: number,
  reason: string,
): Promise<void> {
  await scope.rpc('adjust_stock', { p_batch_id: batchId, p_new_qty: newQty, p_reason: reason });
}

export async function writeOffBatch(
  scope: TenantScope,
  batchId: string,
  reason: string,
): Promise<void> {
  await scope.rpc('write_off_batch', { p_batch_id: batchId, p_reason: reason });
}

/** Гасит бейдж недостачи, не трогая себестоимость закрытого приёма. */
export async function acknowledgeShortfall(scope: TenantScope, movementId: string): Promise<void> {
  await scope.rpc('acknowledge_shortfall', { p_movement_id: movementId });
}
