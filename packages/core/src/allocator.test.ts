import { describe, expect, it } from 'vitest';
import { allocate, buildRequirements } from './allocator.js';
import { formatNumeric, fromWhole, parseNumeric, roundToMinorUnits } from './numeric.js';
import type { CandidateBatch, ExpandedLine } from './types.js';

const DATE = '2026-08-25';

/** Партия по умолчанию: цена известна, срок дальний. */
function batch(over: Partial<CandidateBatch> & Pick<CandidateBatch, 'batchId' | 'materialId'>): CandidateBatch {
  return {
    initialQty: fromWhole(10),
    qtyRemaining: fromWhole(10),
    totalPrice: parseNumeric('100000'),
    expiresAt: '2027-01-01',
    ...over,
  };
}

function line(over: Partial<ExpandedLine> & Pick<ExpandedLine, 'lineId'>): ExpandedLine {
  return {
    materialId: 'm1',
    analogGroupId: null,
    analogMaterialIds: [],
    normQty: fromWhole(1),
    divisible: true,
    scalesWithQuantity: true,
    ...over,
  };
}

describe('контракт округления', () => {
  it('стоимость считается через долю партии, а не через удельную цену', () => {
    // Партия 3 г за 100 000 сум. Удельная цена 33 333.333333 — три списания по 1 г
    // через неё дали бы 99 999.999999. Через долю партии сумма обязана быть ровной.
    const initialQty = fromWhole(3);
    const totalPrice = parseNumeric('100000');
    let consumed = 0n;
    let sum = 0n;

    for (let i = 0; i < 3; i += 1) {
      const b = batch({
        batchId: 'b1',
        materialId: 'm1',
        initialQty,
        qtyRemaining: initialQty - consumed,
        totalPrice,
      });
      const result = allocate({
        requirements: buildRequirements([line({ lineId: 'l1' })], 1),
        batches: [b],
        visitDate: DATE,
      });
      expect(result.shortfalls).toHaveLength(0);
      sum += result.materialsTotal;
      consumed += fromWhole(1);
    }

    expect(formatNumeric(sum)).toBe('100000.000000');
  });

  it('партия, израсходованная одним приёмом в несколько строк, тоже сходится ровно', () => {
    const lines = [
      line({ lineId: 'l1', normQty: fromWhole(1) }),
      line({ lineId: 'l2', normQty: fromWhole(1) }),
      line({ lineId: 'l3', normQty: fromWhole(1) }),
    ];
    const result = allocate({
      requirements: buildRequirements(lines, 1),
      batches: [
        batch({ batchId: 'b1', materialId: 'm1', initialQty: fromWhole(3), qtyRemaining: fromWhole(3) }),
      ],
      visitDate: DATE,
    });
    expect(formatNumeric(result.materialsTotal)).toBe('100000.000000');
  });

  it('делимые единицы не теряют точность: 3 × 0.33 г из партии 1.00 г оставляют ровно 0.010000', () => {
    const initialQty = parseNumeric('1.000000');
    let consumed = 0n;
    for (let i = 0; i < 3; i += 1) {
      const result = allocate({
        requirements: buildRequirements([line({ lineId: 'l1', normQty: parseNumeric('0.33') })], 1),
        batches: [batch({ batchId: 'b1', materialId: 'm1', initialQty, qtyRemaining: initialQty - consumed })],
        visitDate: DATE,
      });
      consumed += result.consumptions[0]!.qty;
    }
    expect(formatNumeric(initialQty - consumed)).toBe('0.010000');
  });

  it('округление денег до тийинов — единственная точка округления', () => {
    expect(formatNumeric(roundToMinorUnits(parseNumeric('33333.333333')))).toBe('33333.330000');
    expect(formatNumeric(roundToMinorUnits(parseNumeric('33333.335000')))).toBe('33333.340000');
  });
});

describe('неделимые единицы', () => {
  it('0.2 мл из неделимой единицы 1 мл списывают одну полную единицу и полную стоимость', () => {
    const result = allocate({
      requirements: buildRequirements(
        [line({ lineId: 'l1', normQty: parseNumeric('0.2'), divisible: false })],
        1,
      ),
      batches: [
        batch({
          batchId: 'b1',
          materialId: 'm1',
          initialQty: fromWhole(10),
          qtyRemaining: fromWhole(10),
          totalPrice: parseNumeric('10000'), // 1000 сум за единицу
        }),
      ],
      visitDate: DATE,
    });
    expect(formatNumeric(result.consumptions[0]!.qty)).toBe('1.000000');
    expect(formatNumeric(result.materialsTotal)).toBe('1000.000000');
  });

  it('округление вверх применяется один раз после умножения: 0.6 × 3 = ⌈1.8⌉ = 2, а не 3', () => {
    const reqs = buildRequirements(
      [line({ lineId: 'l1', normQty: parseNumeric('0.6'), divisible: false, scalesWithQuantity: true })],
      3,
    );
    expect(formatNumeric(reqs[0]!.requiredQty)).toBe('2.000000');
  });

  it('неделимая единица не дробится между партиями', () => {
    const result = allocate({
      requirements: buildRequirements(
        [line({ lineId: 'l1', normQty: fromWhole(3), divisible: false })],
        1,
      ),
      batches: [
        // В первой партии остаток 1.5 единицы — использовать можно только 1 целую.
        batch({
          batchId: 'b1',
          materialId: 'm1',
          initialQty: fromWhole(10),
          qtyRemaining: parseNumeric('1.5'),
          expiresAt: '2026-09-01',
        }),
        batch({ batchId: 'b2', materialId: 'm1', expiresAt: '2026-12-01' }),
      ],
      visitDate: DATE,
    });
    const fromB1 = result.consumptions.find((c) => c.batchId === 'b1');
    expect(formatNumeric(fromB1!.qty)).toBe('1.000000');
    expect(result.consumptions.every((c) => c.qty % 1_000_000n === 0n)).toBe(true);
    expect(result.shortfalls).toHaveLength(0);
  });
});

describe('масштабирование на quantity', () => {
  const lines = [
    line({ lineId: 'canal', materialId: 'hypochlorite', normQty: fromWhole(10), scalesWithQuantity: true }),
    line({ lineId: 'gloves', materialId: 'gloves', normQty: fromWhole(4), scalesWithQuantity: false }),
    line({
      lineId: 'carpule',
      materialId: 'carpule',
      normQty: fromWhole(1),
      divisible: false,
      scalesWithQuantity: false,
    }),
  ];

  it('масштабируемая часть растёт втрое на моляре с тремя каналами', () => {
    const reqs = buildRequirements(lines, 3);
    expect(formatNumeric(reqs.find((r) => r.lineId === 'canal')!.requiredQty)).toBe('30.000000');
  });

  it('фиксированная часть остаётся в единственном числе', () => {
    const reqs = buildRequirements(lines, 3);
    expect(formatNumeric(reqs.find((r) => r.lineId === 'gloves')!.requiredQty)).toBe('4.000000');
    expect(formatNumeric(reqs.find((r) => r.lineId === 'carpule')!.requiredQty)).toBe('1.000000');
  });
});

describe('FEFO', () => {
  it('первой расходуется партия с ближайшим сроком годности', () => {
    const result = allocate({
      requirements: buildRequirements([line({ lineId: 'l1', normQty: fromWhole(1) })], 1),
      batches: [
        batch({ batchId: 'later', materialId: 'm1', expiresAt: '2027-06-01' }),
        batch({ batchId: 'sooner', materialId: 'm1', expiresAt: '2026-09-01' }),
      ],
      visitDate: DATE,
    });
    expect(result.consumptions[0]!.batchId).toBe('sooner');
  });

  it('просроченная партия в кандидаты не попадает и уходит в недостачу, а не в себестоимость', () => {
    const result = allocate({
      requirements: buildRequirements([line({ lineId: 'l1', normQty: fromWhole(1) })], 1),
      batches: [batch({ batchId: 'expired', materialId: 'm1', expiresAt: '2026-01-01' })],
      visitDate: DATE,
    });
    expect(result.consumptions).toHaveLength(0);
    expect(result.shortfalls).toHaveLength(1);
  });

  it('бессрочная партия расходуется после партий со сроком', () => {
    const result = allocate({
      requirements: buildRequirements([line({ lineId: 'l1', normQty: fromWhole(1) })], 1),
      batches: [
        batch({ batchId: 'eternal', materialId: 'm1', expiresAt: null }),
        batch({ batchId: 'dated', materialId: 'm1', expiresAt: '2027-01-01' }),
      ],
      visitDate: DATE,
    });
    expect(result.consumptions[0]!.batchId).toBe('dated');
  });
});

describe('группы аналогов', () => {
  it('строка не смешивает аналоги: следующий берётся только когда предыдущий исчерпан', () => {
    const result = allocate({
      requirements: buildRequirements(
        [
          line({
            lineId: 'l1',
            materialId: null,
            analogGroupId: 'g1',
            analogMaterialIds: ['a', 'b'],
            normQty: fromWhole(2),
          }),
        ],
        1,
      ),
      batches: [
        batch({ batchId: 'ba', materialId: 'a', initialQty: fromWhole(5), qtyRemaining: fromWhole(5) }),
        batch({ batchId: 'bb', materialId: 'b', initialQty: fromWhole(5), qtyRemaining: fromWhole(5) }),
      ],
      visitDate: DATE,
    });
    expect(result.consumptions).toHaveLength(1);
    expect(result.consumptions[0]!.materialId).toBe('a');
  });

  it('к следующему аналогу переходит, когда первого физически не хватает', () => {
    const result = allocate({
      requirements: buildRequirements(
        [
          line({
            lineId: 'l1',
            materialId: null,
            analogGroupId: 'g1',
            analogMaterialIds: ['a', 'b'],
            normQty: fromWhole(5),
          }),
        ],
        1,
      ),
      batches: [
        batch({ batchId: 'ba', materialId: 'a', initialQty: fromWhole(2), qtyRemaining: fromWhole(2) }),
        batch({ batchId: 'bb', materialId: 'b', initialQty: fromWhole(5), qtyRemaining: fromWhole(5) }),
      ],
      visitDate: DATE,
    });
    expect(result.consumptions.map((c) => c.materialId)).toEqual(['a', 'b']);
    expect(result.shortfalls).toHaveLength(0);
  });
});

describe('вариант A′ — недостача вместо отказа', () => {
  it('при нулевых остатках аллокация не падает, а даёт строки недостачи', () => {
    const result = allocate({
      requirements: buildRequirements([line({ lineId: 'l1', normQty: fromWhole(5) })], 1),
      batches: [],
      visitDate: DATE,
    });
    expect(result.consumptions).toHaveLength(0);
    expect(formatNumeric(result.shortfalls[0]!.qty)).toBe('5.000000');
  });

  it('остаток партии никогда не уходит ниже нуля — непокрытое становится недостачей', () => {
    const result = allocate({
      requirements: buildRequirements([line({ lineId: 'l1', normQty: fromWhole(10) })], 1),
      batches: [
        batch({ batchId: 'b1', materialId: 'm1', initialQty: fromWhole(10), qtyRemaining: fromWhole(4) }),
      ],
      visitDate: DATE,
    });
    expect(formatNumeric(result.consumptions[0]!.qty)).toBe('4.000000');
    expect(formatNumeric(result.shortfalls[0]!.qty)).toBe('6.000000');
  });

  it('недостача оценивается по последней известной цене материала', () => {
    const result = allocate({
      requirements: buildRequirements([line({ lineId: 'l1', normQty: fromWhole(2) })], 1),
      batches: [
        // Партия просрочена и потому не кандидат, но её цена остаётся ориентиром.
        batch({
          batchId: 'old',
          materialId: 'm1',
          initialQty: fromWhole(10),
          qtyRemaining: 0n,
          totalPrice: parseNumeric('50000'),
          expiresAt: '2026-01-01',
        }),
      ],
      visitDate: DATE,
    });
    expect(result.shortfalls[0]!.unpriced).toBe(false);
    expect(formatNumeric(result.shortfalls[0]!.cost!)).toBe('10000.000000');
  });

  it('когда цены нет вовсе — cost null и флаг unpriced, но никогда не ноль', () => {
    const result = allocate({
      requirements: buildRequirements([line({ lineId: 'l1', normQty: fromWhole(2) })], 1),
      batches: [],
      visitDate: DATE,
    });
    expect(result.shortfalls[0]!.cost).toBeNull();
    expect(result.hasUnpriced).toBe(true);
    expect(result.unpricedLinesCount).toBe(1);
    expect(result.materialsTotal).toBe(0n);
  });

  it('смешанный приём: известная часть суммируется, неизвестная считается отдельно', () => {
    const result = allocate({
      requirements: buildRequirements(
        [
          line({ lineId: 'priced', materialId: 'm1', normQty: fromWhole(1) }),
          line({ lineId: 'unpriced', materialId: 'm2', normQty: fromWhole(1) }),
        ],
        1,
      ),
      batches: [
        batch({ batchId: 'b1', materialId: 'm1', initialQty: fromWhole(10), totalPrice: parseNumeric('10000') }),
        batch({ batchId: 'b2', materialId: 'm2', initialQty: fromWhole(10), totalPrice: null }),
      ],
      visitDate: DATE,
    });
    expect(formatNumeric(result.materialsTotal)).toBe('1000.000000');
    expect(result.hasUnpriced).toBe(true);
    expect(result.unpricedLinesCount).toBe(1);
  });
});

describe('инвариант драйвера №1', () => {
  it('Σ(cost по строкам с известной ценой) == materialsTotal на несократимых дробях', () => {
    // Партии по 3, 7 и 11 единиц — доли не сокращаются, дробь остаётся на каждом шаге.
    for (const size of [3, 7, 11]) {
      for (let need = 1; need <= size; need += 1) {
        const result = allocate({
          requirements: buildRequirements([line({ lineId: 'l1', normQty: fromWhole(need) })], 1),
          batches: [
            batch({
              batchId: `b${size}`,
              materialId: 'm1',
              initialQty: fromWhole(size),
              qtyRemaining: fromWhole(size),
              totalPrice: parseNumeric('100000'),
            }),
          ],
          visitDate: DATE,
        });
        const sum = [...result.consumptions, ...result.shortfalls]
          .filter((m) => m.cost !== null)
          .reduce((acc, m) => acc + m.cost!, 0n);
        expect(sum).toBe(result.materialsTotal);
      }
    }
  });

  it('партия, израсходованная по одной единице до конца, отдаёт ровно свою цену', () => {
    for (const size of [3, 7, 11]) {
      const initialQty = fromWhole(size);
      const totalPrice = parseNumeric('100000');
      let consumed = 0n;
      let sum = 0n;
      for (let i = 0; i < size; i += 1) {
        const result = allocate({
          requirements: buildRequirements([line({ lineId: 'l1', normQty: fromWhole(1) })], 1),
          batches: [
            batch({ batchId: 'b1', materialId: 'm1', initialQty, qtyRemaining: initialQty - consumed, totalPrice }),
          ],
          visitDate: DATE,
        });
        sum += result.materialsTotal;
        consumed += fromWhole(1);
      }
      expect(formatNumeric(sum)).toBe('100000.000000');
    }
  });
});
