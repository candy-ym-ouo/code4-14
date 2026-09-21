import { describe, expect, it } from "vitest";
import { allocateConsumptionCost, allocationFingerprint, reverseAllocation, type RateMap } from "../src/lib/costing.js";

function rates(entries: Array<[string, string, string]>): RateMap {
  return new Map(entries.map(([currency, rate, effectiveFrom]) => [currency, { rate, effectiveFrom }]));
}

describe("allocateConsumptionCost", () => {
  it("allocates opening purchase cost between used quantity and waste in base currency", () => {
    const result = allocateConsumptionCost({
      usedQuantity: "450.000000",
      wasteQuantity: "50.000000",
      layers: [
        { amount: "120.00", currency: "CNY", quantityBasis: "1000.000000", reference: "OPENING" }
      ],
      batchCurrency: "CNY",
      rates: rates([]),
      baseCurrency: "CNY",
      valueDate: "2026-09-21"
    });
    expect(result.status ?? result.totalCostBase).toBe("60.00");
    expect(result.usedCostBase).toBe("54.00");
    expect(result.wasteCostBase).toBe("6.00");
    expect(result.currency).toBe("CNY");
    expect(result.exchangeRate).toBe("1");
  });

  it("absorbs rounding remainder into waste and keeps the sum exact", () => {
    const result = allocateConsumptionCost({
      usedQuantity: "333.000000",
      wasteQuantity: "334.000000",
      layers: [{ amount: "1.00", currency: "CNY", quantityBasis: "1000.000000", reference: "OPENING" }],
      batchCurrency: "CNY",
      rates: rates([]),
      baseCurrency: "CNY",
      valueDate: "2026-09-21"
    });
    const sum = BigInt(result.usedCostBase.replace(".", "")) + BigInt(result.wasteCostBase.replace(".", ""));
    expect(sum).toBe(BigInt(result.totalCostBase.replace(".", "")));
  });

  it("converts a foreign-currency batch with the rate effective on the value date", () => {
    const result = allocateConsumptionCost({
      usedQuantity: "100.000000",
      wasteQuantity: "0.000000",
      layers: [{ amount: "10.00", currency: "USD", quantityBasis: "1000.000000", reference: "OPENING" }],
      batchCurrency: "USD",
      rates: rates([["USD", "7.1823000000", "2026-09-01"]]),
      baseCurrency: "CNY",
      valueDate: "2026-09-21"
    });
    // 100g/1000g 承担 10 USD 的 1/10：1 USD × 7.1823 = 7.1823 → 7.18
    expect(result.totalCostBase).toBe("7.18");
    expect(result.currency).toBe("USD");
    expect(result.exchangeRate).toBe("7.1823000000");
    expect(result.exchangeRateDate).toBe("2026-09-01");
  });

  it("converts the full batch cost when the entire quantity is consumed", () => {
    const result = allocateConsumptionCost({
      usedQuantity: "1000.000000",
      wasteQuantity: "0.000000",
      layers: [{ amount: "10.00", currency: "USD", quantityBasis: "1000.000000", reference: "OPENING" }],
      batchCurrency: "USD",
      rates: rates([["USD", "7.1823000000", "2026-09-01"]]),
      baseCurrency: "CNY",
      valueDate: "2026-09-21"
    });
    // 10 USD × 7.1823 = 71.823 → 71.82
    expect(result.totalCostBase).toBe("71.82");
    expect(result.totalCostOrig).toBe("10.00");
  });

  it("treats later cost adjustments as new layers spread over the remaining quantity", () => {
    // 入库 1000g / 100 CNY；剩余 500g 时补录运费 20 CNY。
    // 再消耗 100g（无损耗）：OPENING 层 100/1000*100 = 10；补录层 20/500*100 = 4 → 14.00
    const result = allocateConsumptionCost({
      usedQuantity: "100.000000",
      wasteQuantity: "0.000000",
      layers: [
        { amount: "100.00", currency: "CNY", quantityBasis: "1000.000000", reference: "OPENING" },
        { amount: "20.00", currency: "CNY", quantityBasis: "500.000000", reference: "ADJUSTMENT:adj-1" }
      ],
      batchCurrency: "CNY",
      rates: rates([]),
      baseCurrency: "CNY",
      valueDate: "2026-09-21"
    });
    expect(result.totalCostBase).toBe("14.00");
    expect(result.basis.layers).toHaveLength(2);
  });

  it("throws MISSING_EXCHANGE_RATE when a needed rate version is absent", () => {
    expect(() => allocateConsumptionCost({
      usedQuantity: "100.000000",
      wasteQuantity: "0.000000",
      layers: [{ amount: "10.00", currency: "EUR", quantityBasis: "1000.000000", reference: "OPENING" }],
      batchCurrency: "EUR",
      rates: rates([]),
      baseCurrency: "CNY",
      valueDate: "2026-09-21"
    })).toThrow("MISSING_EXCHANGE_RATE");
  });

  it("is stable: identical inputs yield identical fingerprints and outputs", () => {
    const options = {
      usedQuantity: "120.000000",
      wasteQuantity: "30.000000",
      layers: [
        { amount: "100.00", currency: "USD", quantityBasis: "1000.000000", reference: "OPENING" },
        { amount: "20.00", currency: "USD", quantityBasis: "500.000000", reference: "ADJUSTMENT:adj-1" }
      ],
      batchCurrency: "USD",
      rates: rates([["USD", "7.1000000000", "2026-09-01"]]),
      baseCurrency: "CNY",
      valueDate: "2026-09-21"
    } as const;
    const first = allocateConsumptionCost(options);
    const second = allocateConsumptionCost(options);
    expect(allocationFingerprint(first)).toBe(allocationFingerprint(second));
    expect(first.totalCostBase).toBe(second.totalCostBase);

    // 补录新汇率版本后指纹必然变化（驱动重算产生新版本）
    const rerated = allocateConsumptionCost({
      ...options,
      rates: rates([["USD", "7.2000000000", "2026-09-10"]])
    });
    expect(allocationFingerprint(rerated)).not.toBe(allocationFingerprint(first));
    expect(rerated.totalCostBase).not.toBe(first.totalCostBase);
  });

  it("mirror reversal negates every monetary column while keeping quantities and basis", () => {
    const original = allocateConsumptionCost({
      usedQuantity: "450.000000",
      wasteQuantity: "50.000000",
      layers: [{ amount: "120.00", currency: "CNY", quantityBasis: "1000.000000", reference: "OPENING" }],
      batchCurrency: "CNY",
      rates: rates([]),
      baseCurrency: "CNY",
      valueDate: "2026-09-21"
    });
    const reversal = reverseAllocation(original);
    expect(reversal.totalCostBase).toBe("-60.00");
    expect(reversal.usedCostBase).toBe("-54.00");
    expect(reversal.wasteCostBase).toBe("-6.00");
    expect(reversal.totalQuantity).toBe(original.totalQuantity);
    expect(BigInt(original.totalCostBase.replace(".", "")) + BigInt(reversal.totalCostBase.replace(".", ""))).toBe(0n);
  });

  it("simulates the DRAFT -> reverse -> backfill -> recompute lifecycle with zero net", () => {
    // 1) 消耗时没有采购成本：无法计算（服务层会落 DRAFT 0 元凭证与 0 元红冲，净额 0）。
    const missing = () => allocateConsumptionCost({
      usedQuantity: "450.000000",
      wasteQuantity: "50.000000",
      layers: [],
      batchCurrency: null,
      rates: rates([]),
      baseCurrency: "CNY",
      valueDate: "2026-09-21"
    });
    // 空层时引擎本身无错（结果 0）；缺的是“批次录入了采购费但无汇率”的场景：
    expect(missing().totalCostBase).toBe("0.00");
    expect(() => allocateConsumptionCost({
      usedQuantity: "450.000000",
      wasteQuantity: "50.000000",
      layers: [{ amount: "100.00", currency: "USD", quantityBasis: "1000.000000", reference: "OPENING" }],
      batchCurrency: "USD",
      rates: rates([]),
      baseCurrency: "CNY",
      valueDate: "2026-09-21"
    })).toThrow("MISSING_EXCHANGE_RATE");

    // 2) 补录汇率后重算：消耗链得到金额，红冲链是其镜像，净额仍为 0。
    const recomputed = allocateConsumptionCost({
      usedQuantity: "450.000000",
      wasteQuantity: "50.000000",
      layers: [{ amount: "100.00", currency: "USD", quantityBasis: "1000.000000", reference: "OPENING" }],
      batchCurrency: "USD",
      rates: rates([["USD", "7.1823000000", "2026-09-01"]]),
      baseCurrency: "CNY",
      valueDate: "2026-09-21"
    });
    const reversedAgain = reverseAllocation(recomputed);
    expect(BigInt(recomputed.totalCostBase.replace(".", "")) + BigInt(reversedAgain.totalCostBase.replace(".", ""))).toBe(0n);

    // 3) 再做一次幂等重算：相同输入相同指纹，不应产生新版本。
    const onceMore = allocateConsumptionCost({
      usedQuantity: "450.000000",
      wasteQuantity: "50.000000",
      layers: [{ amount: "100.00", currency: "USD", quantityBasis: "1000.000000", reference: "OPENING" }],
      batchCurrency: "USD",
      rates: rates([["USD", "7.1823000000", "2026-09-01"]]),
      baseCurrency: "CNY",
      valueDate: "2026-09-21"
    });
    expect(allocationFingerprint(onceMore)).toBe(allocationFingerprint(recomputed));
  });
});
