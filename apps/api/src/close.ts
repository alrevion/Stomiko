import {
  allocate,
  buildRequirements,
  formatNumeric,
  parseNumeric,
  roundToMinorUnits,
} from '@stomiko/core';
import type { CandidateBatch, ExpandedLine, Requirement } from '@stomiko/core';
import type { TenantScope } from './db.js';

/** Ответ get_close_context. numeric приходит строками — во float не превращаем. */
interface CloseContext {
  visit: { id: string; tenantId: string; locationId: string; visitDate: string; status: string };
  services: {
    visitServiceId: string;
    serviceId: string;
    quantity: number;
    price: string;
    lines: {
      lineId: string;
      materialId: string | null;
      analogGroupId: string | null;
      analogMaterialIds: string[];
      normQty: string;
      divisible: boolean;
      scalesWithQuantity: boolean;
    }[];
  }[];
  batches: {
    batchId: string;
    materialId: string;
    initialQty: string;
    qtyRemaining: string;
    totalPrice: string | null;
    expiresAt: string | null;
  }[];
}

export interface CloseResult {
  status: 'closed' | 'already_closed';
  visitCostId: string;
  materialsTotal: string;
  hasUnpriced: boolean;
  unpricedLinesCount: number;
  consumptions: number;
  shortfalls: number;
  attempts: number;
}

function toRequirements(ctx: CloseContext): Requirement[] {
  const out: Requirement[] = [];
  for (const svc of ctx.services) {
    const lines: ExpandedLine[] = svc.lines.map((l) => ({
      // lineId уникален по приёму: одна и та же строка снимка может прийти
      // от двух разных оказанных услуг.
      lineId: `${svc.visitServiceId}:${l.lineId}`,
      materialId: l.materialId,
      analogGroupId: l.analogGroupId,
      analogMaterialIds: l.analogMaterialIds,
      normQty: parseNumeric(l.normQty),
      divisible: l.divisible,
      scalesWithQuantity: l.scalesWithQuantity,
    }));
    out.push(...buildRequirements(lines, svc.quantity));
  }
  return out;
}

function toBatches(ctx: CloseContext): CandidateBatch[] {
  return ctx.batches.map((b) => ({
    batchId: b.batchId,
    materialId: b.materialId,
    initialQty: parseNumeric(b.initialQty),
    qtyRemaining: parseNumeric(b.qtyRemaining),
    totalPrice: b.totalPrice === null ? null : parseNumeric(b.totalPrice),
    expiresAt: b.expiresAt,
  }));
}

/**
 * Закрытие приёма: два round-trip'а с чистым расчётом между ними.
 *
 *   RTT 1  get_close_context   — снимок техкарт + кандидатные партии
 *   (JS)   allocate            — чистая функция, ни одного обращения к БД
 *   RTT 2  apply_visit_close   — одна транзакция в Postgres
 *
 * Между RTT 1 и RTT 2 партию мог израсходовать другой приём, поэтому применение
 * оптимистическое: `apply_visit_close` сверяет остаток каждой партии с ожидаемым
 * и откатывается целиком при расхождении (SQLSTATE 40001). Здесь мы просто
 * перечитываем контекст и повторяем.
 */
export async function closeVisit(
  scope: TenantScope,
  visitId: string,
  maxAttempts = 3,
): Promise<CloseResult> {
  let lastConflict: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const ctx = await scope.rpc<CloseContext>('get_close_context', { p_visit_id: visitId });

    if (ctx.visit.status === 'closed') {
      const applied = await scope.rpc<Record<string, unknown>>('apply_visit_close', {
        p_visit_id: visitId,
        p_allocation: { consumptions: [], shortfalls: [], materialsTotal: '0', unpricedLinesCount: 0 },
      });
      return {
        status: 'already_closed',
        visitCostId: String(applied.visitCostId),
        materialsTotal: String(applied.materialsTotal),
        hasUnpriced: Boolean(applied.hasUnpriced),
        unpricedLinesCount: Number(applied.unpricedLinesCount),
        consumptions: 0,
        shortfalls: 0,
        attempts: attempt,
      };
    }

    if (ctx.services.length === 0) {
      throw Object.assign(new Error('в приёме нет ни одной услуги'), { httpStatus: 400 });
    }

    const allocation = allocate({
      requirements: toRequirements(ctx),
      batches: toBatches(ctx),
      visitDate: ctx.visit.visitDate,
    });

    // bigint микро-единиц → numeric-строки. Округление денег до тийинов
    // происходит ровно здесь и больше нигде.
    const payload = {
      consumptions: allocation.consumptions.map((c) => ({
        lineId: c.lineId,
        batchId: c.batchId,
        materialId: c.materialId,
        qty: formatNumeric(c.qty),
        cost: c.cost === null ? null : formatNumeric(c.cost),
        unpriced: c.unpriced,
        expectedQtyRemaining: formatNumeric(c.expectedQtyRemaining),
      })),
      shortfalls: allocation.shortfalls.map((s) => ({
        lineId: s.lineId,
        materialId: s.materialId,
        qty: formatNumeric(s.qty),
        cost: s.cost === null ? null : formatNumeric(s.cost),
        unpriced: s.unpriced,
      })),
      materialsTotal: formatNumeric(roundToMinorUnits(allocation.materialsTotal)),
      hasUnpriced: allocation.hasUnpriced,
      unpricedLinesCount: allocation.unpricedLinesCount,
    };

    try {
      const applied = await scope.rpc<Record<string, unknown>>('apply_visit_close', {
        p_visit_id: visitId,
        p_allocation: payload,
      });
      return {
        status: applied.status === 'already_closed' ? 'already_closed' : 'closed',
        visitCostId: String(applied.visitCostId),
        materialsTotal: String(applied.materialsTotal),
        hasUnpriced: Boolean(applied.hasUnpriced),
        unpricedLinesCount: Number(applied.unpricedLinesCount),
        consumptions: allocation.consumptions.length,
        shortfalls: allocation.shortfalls.length,
        attempts: attempt,
      };
    } catch (err) {
      const code = (err as { pgCode?: string }).pgCode;
      // 40001 — конфликт версии партии. Всё остальное не ретраится.
      if (code !== '40001' && !String((err as Error).message).includes('конфликт версии')) throw err;
      lastConflict = err;
    }
  }

  throw Object.assign(
    new Error(`не удалось закрыть приём за ${maxAttempts} попытки: партии меняются слишком часто`),
    { httpStatus: 409, cause: lastConflict },
  );
}
