import { Hono } from 'hono';
import type { Env, Identity, TenantScope } from '../db.js';
import { adjustStock, receiveBatch, writeOffBatch } from '../stock.js';

type Vars = { scope: TenantScope; identity: Identity };
export const warehouse = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * Склад — единственное место, где живут материалы.
 *
 * Порядок работы: сначала завести материал и оприходовать партию, и только
 * потом ставить его в техкарту. Обратный порядок означал бы нормирование
 * расхода того, чего на складе нет, — и первая же закрытая карта дала бы
 * строку недостачи вместо себестоимости.
 */

async function locationId(scope: TenantScope): Promise<string> {
  const { data } = await scope.select('locations', 'id').limit(1);
  const row = (data ?? [])[0];
  if (!row) throw new Error('у кабинета нет филиала');
  return String(row.id);
}

interface StockRow {
  material_id: string; name_ru: string; name_uz: string; category: string | null;
  unit_ru: string; unit_code: string; divisible: boolean;
  reference_price: string | null; qty_remaining: string;
  batches: number; nearest_expiry: string | null; expired_qty: string;
  used_in_techcards: number;
}

warehouse.get('/', async (c) => {
  const scope = c.get('scope');
  const [rows, units] = await Promise.all([
    scope.rpc<StockRow[]>('stock_overview', { p_tenant_id: scope.tenantId }),
    scope.select('units', 'id, code, name_ru, divisible').order('code'),
  ]);

  const materials = (rows ?? []).map((r) => ({
    id: r.material_id,
    nameRu: r.name_ru,
    nameUz: r.name_uz,
    category: r.category,
    unit: r.unit_ru,
    unitCode: r.unit_code,
    divisible: r.divisible,
    referencePrice: r.reference_price === null ? null : Number(r.reference_price),
    qty: Number(r.qty_remaining),
    batches: r.batches,
    nearestExpiry: r.nearest_expiry,
    expiredQty: Number(r.expired_qty),
    usedInTechcards: Number(r.used_in_techcards),
    // Материал без цены ломает расчёт себестоимости: приём получит строку
    // без цены, а маржа покажется завышенной. Врач должен видеть это заранее.
    needsPrice: r.reference_price === null,
    outOfStock: Number(r.qty_remaining) <= 0,
  }));

  return c.json({
    materials,
    units: units.data ?? [],
    summary: {
      total: materials.length,
      outOfStock: materials.filter((m) => m.outOfStock).length,
      needsPrice: materials.filter((m) => m.needsPrice).length,
      expiring: materials.filter((m) => m.expiredQty > 0).length,
      value: materials.reduce((s, m) => s + (m.referencePrice ?? 0) * m.qty, 0),
    },
  });
});

/**
 * Сверка проекции остатков с журналом.
 *
 * Зарегистрирована ДО '/:materialId': иначе 'health' будет разобран как
 * идентификатор материала, и запрос упадёт с ошибкой приведения к uuid.
 */
warehouse.get('/health', async (c) => {
  const scope = c.get('scope');
  const mismatches = await scope.rpc<unknown[]>('reconcile_batches', { p_tenant_id: scope.tenantId });
  const { data: shortfalls } = await scope
    .select('stock_movements', 'id, qty_delta, materials(name_ru)')
    .eq('kind', 'shortfall').eq('shortfall_state', 'open');
  return c.json({
    reconcileMismatches: (mismatches ?? []).length,
    openShortfalls: (shortfalls ?? []).length,
    shortfalls: shortfalls ?? [],
  });
});

warehouse.get('/:materialId', async (c) => {
  const scope = c.get('scope');
  const materialId = c.req.param('materialId');
  const [batches, material] = await Promise.all([
    scope.rpc<Record<string, unknown>[]>('material_batches', {
      p_tenant_id: scope.tenantId, p_material_id: materialId,
    }),
    scope.select('materials', 'id, name_ru, name_uz, category, reference_price, base_unit_id')
      .eq('id', materialId).maybeSingle(),
  ]);
  if (!material.data) return c.json({ error: 'материал не найден' }, 404);

  const { data: unit } = await scope.select('units', 'id, name_ru, code, divisible')
    .eq('id', material.data.base_unit_id).maybeSingle();

  return c.json({ material: material.data, unit, batches: batches ?? [] });
});

warehouse.post('/', async (c) => {
  const scope = c.get('scope');
  const b = await c.req.json<{ nameRu: string; nameUz?: string; unitId: string; category?: string; referencePrice?: number | null }>();
  try {
    const id = await scope.rpc<string>('create_material', {
      p_tenant_id: scope.tenantId,
      p_name_ru: b.nameRu,
      p_name_uz: b.nameUz ?? '',
      p_unit_id: b.unitId,
      p_category: b.category ?? '',
      p_reference_price: b.referencePrice ?? null,
    });
    return c.json({ materialId: id });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

warehouse.put('/:materialId', async (c) => {
  const scope = c.get('scope');
  const b = await c.req.json<{ nameRu?: string; nameUz?: string; category?: string; referencePrice?: number | null }>();
  try {
    await scope.rpc('update_material', {
      p_material_id: c.req.param('materialId'),
      p_name_ru: b.nameRu ?? '',
      p_name_uz: b.nameUz ?? '',
      p_category: b.category ?? '',
      p_reference_price: b.referencePrice ?? null,
    });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

warehouse.delete('/:materialId', async (c) => {
  try {
    await c.get('scope').rpc('delete_material', { p_material_id: c.req.param('materialId') });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** Приход партии. Цена и срок годности — здесь, а не в техкарте. */
warehouse.post('/:materialId/receive', async (c) => {
  const scope = c.get('scope');
  const b = await c.req.json<{ qty: number; totalPrice: number | null; expiresAt: string | null; supplier?: string }>();
  if (!(b.qty > 0)) return c.json({ error: 'количество должно быть больше нуля' }, 400);
  try {
    const id = await receiveBatch(scope, {
      locationId: await locationId(scope),
      materialId: c.req.param('materialId'),
      qty: b.qty,
      totalPrice: b.totalPrice && b.totalPrice > 0 ? b.totalPrice : null,
      expiresAt: b.expiresAt || null,
      supplier: b.supplier,
      priceEstimated: !b.totalPrice,
    });
    return c.json({ batchId: id });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** Инвентаризация. Причина обязательна — иначе через месяц никто не вспомнит. */
warehouse.post('/batches/:batchId/adjust', async (c) => {
  const b = await c.req.json<{ newQty: number; reason: string }>();
  if (!b.reason?.trim()) return c.json({ error: 'укажите причину корректировки' }, 400);
  try {
    await adjustStock(c.get('scope'), c.req.param('batchId'), b.newQty, b.reason.trim());
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

warehouse.post('/batches/:batchId/write-off', async (c) => {
  const b = await c.req.json<{ reason?: string }>().catch(() => ({ reason: '' }));
  try {
    await writeOffBatch(c.get('scope'), c.req.param('batchId'), b.reason?.trim() || 'утилизация');
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});
