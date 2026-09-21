import { describe, expect, it } from "vitest";
import {
  addMoney,
  compareMoney,
  computeProjectCost,
  convertMoneyToBase,
  prorateAmount,
  unitCostBase,
  type CostBatchInput,
  type CostConsumptionInput,
  type RateResolver
} from "../src/index.js";

const fixedRate =
  (table: Record<string, string>): RateResolver =>
  (currency) => {
    const rate = table[currency];
    return rate === undefined ? null : { rate, rateId: `${currency}-rate` };
  };

describe("fixed-point money operations", () => {
  it("converts foreign amounts to base currency with deterministic rounding", () => {
    expect(convertMoneyToBase("100.00", "7.125")).toBe("712.50");
    expect(convertMoneyToBase("0.01", "0.5")).toBe("0.01");
    expect(convertMoneyToBase("10.00", "0.33333333")).toBe("3.33");
    // 半进舍入：0.005 → 0.01，负数同样按绝对值半进
    expect(convertMoneyToBase("0.01", "0.55")).toBe("0.01");
    expect(convertMoneyToBase("-10.00", "0.125")).toBe("-1.25");
    expect(convertMoneyToBase("-0.01", "0.55")).toBe("-0.01");
  });

  it("prorates amounts by quantity share without floating point drift", () => {
    expect(prorateAmount("100.00", "1", "3")).toBe("33.33");
    expect(prorateAmount("100.00", "2", "3")).toBe("66.67");
    expect(prorateAmount("0.05", "1", "2")).toBe("0.03");
    expect(prorateAmount("999999999999.99", "0.000001", "1000000")).toBe("1.00");
  });

  it("adds and compares money exactly", () => {
    expect(addMoney("0.10", "0.20")).toBe("0.30");
    expect(addMoney("-5.00", "2.50")).toBe("-2.50");
    expect(compareMoney("1.00", "1.01")).toBe(-1);
  });

  it("derives unit cost snapshots at 8 decimals", () => {
    expect(unitCostBase("100.00", "1000")).toBe("0.10000000");
    expect(unitCostBase("10.00", "3")).toBe("3.33333333");
  });
});

describe("project cost computation", () => {
  const batches: CostBatchInput[] = [
    {
      batchId: "batch-usd",
      totalCost: "100.00",
      currency: "USD",
      receivedAt: "2026-01-10",
      initialQuantity: "1000",
      adjustments: [
        { amount: "20.00", currency: "USD", incurredOn: "2026-01-12" },
        { amount: "-5.00", currency: "USD", incurredOn: "2026-01-15" }
      ]
    },
    {
      batchId: "batch-local",
      totalCost: "50.00",
      currency: "CNY",
      receivedAt: "2026-01-11",
      initialQuantity: "500",
      adjustments: []
    },
    {
      batchId: "batch-gift",
      totalCost: null,
      currency: null,
      receivedAt: "2026-01-12",
      initialQuantity: "200",
      adjustments: []
    }
  ];
  const consumptions: CostConsumptionInput[] = [
    { consumptionId: "c1", batchId: "batch-usd", usedQuantity: "90", wasteQuantity: "10" },
    { consumptionId: "c2", batchId: "batch-local", usedQuantity: "100", wasteQuantity: "0" },
    { consumptionId: "c3", batchId: "batch-gift", usedQuantity: "50", wasteQuantity: "5" }
  ];
  const rates = fixedRate({ USD: "7.00" });

  it("allocates purchase cost, fees and waste by batch, quantity and currency", () => {
    const result = computeProjectCost("CNY", batches, consumptions, rates);
    expect(result.missingRates).toEqual([]);
    const usdLine = result.lines.find((line) => line.consumptionId === "c1");
    // (100 + 20 - 5) USD × 7.00 = 805.00 CNY，按 100/1000 分摊
    expect(usdLine?.batchTotalCostBase).toBe("805.00");
    expect(usdLine?.usedCostBase).toBe("72.45");
    expect(usdLine?.wasteCostBase).toBe("8.05");
    expect(usdLine?.totalCostBase).toBe("80.50");
    expect(usdLine?.fxRate).toBe("7.00000000");
    expect(usdLine?.fxRateId).toBe("USD-rate");
    const localLine = result.lines.find((line) => line.consumptionId === "c2");
    expect(localLine?.fxRate).toBe("1.00000000");
    expect(localLine?.fxRateId).toBeNull();
    expect(localLine?.usedCostBase).toBe("10.00");
    const giftLine = result.lines.find((line) => line.consumptionId === "c3");
    expect(giftLine?.priced).toBe(false);
    expect(giftLine?.totalCostBase).toBeNull();
    expect(result.totals.usedCostBase).toBe("82.45");
    expect(result.totals.wasteCostBase).toBe("8.05");
    expect(result.totals.totalCostBase).toBe("90.50");
    expect(result.totals.pricedLineCount).toBe(2);
    expect(result.totals.unpricedLineCount).toBe(1);
  });

  it("is stable: recomputation with the same inputs yields identical lines", () => {
    const first = computeProjectCost("CNY", batches, consumptions, rates);
    const second = computeProjectCost("CNY", batches, consumptions, rates);
    expect(second).toEqual(first);
  });

  it("reports missing exchange rates without pricing affected lines", () => {
    const result = computeProjectCost("CNY", batches, consumptions, fixedRate({}));
    // 货款与两笔费用各自的发生日期都需要汇率
    expect(result.missingRates).toEqual([
      { currency: "USD", onDate: "2026-01-10" },
      { currency: "USD", onDate: "2026-01-12" },
      { currency: "USD", onDate: "2026-01-15" }
    ]);
    const usdLine = result.lines.find((line) => line.consumptionId === "c1");
    expect(usdLine?.priced).toBe(false);
    // 本位币批次不受影响
    const localLine = result.lines.find((line) => line.consumptionId === "c2");
    expect(localLine?.priced).toBe(true);
  });

  it("recalculates deterministically after a rate is backfilled", () => {
    const before = computeProjectCost("CNY", batches, consumptions, fixedRate({ USD: "7.00" }));
    const after = computeProjectCost("CNY", batches, consumptions, fixedRate({ USD: "7.20" }));
    expect(after.lines.find((line) => line.consumptionId === "c1")?.batchTotalCostBase).toBe("828.00");
    // 再次以新汇率重算，结果不变（幂等）
    const again = computeProjectCost("CNY", batches, consumptions, fixedRate({ USD: "7.20" }));
    expect(again).toEqual(after);
    expect(before.lines.find((line) => line.consumptionId === "c1")?.batchTotalCostBase).toBe("805.00");
  });

  it("keeps line totals self-consistent when rounding splits used and waste", () => {
    const oddBatches: CostBatchInput[] = [
      { batchId: "b", totalCost: "0.05", currency: "CNY", receivedAt: "2026-01-01", initialQuantity: "3", adjustments: [] }
    ];
    const oddConsumptions: CostConsumptionInput[] = [
      { consumptionId: "x", batchId: "b", usedQuantity: "1", wasteQuantity: "1" }
    ];
    const result = computeProjectCost("CNY", oddBatches, oddConsumptions, fixedRate({}));
    const line = result.lines[0];
    expect(line?.usedCostBase).toBe("0.02");
    expect(line?.wasteCostBase).toBe("0.02");
    // 行总额恒等于行内使用 + 损耗，而不是独立分摊的第三个数
    expect(line?.totalCostBase).toBe("0.04");
  });

  it("warns when credits exceed the purchase cost instead of hiding the negative total", () => {
    const negativeBatches: CostBatchInput[] = [
      {
        batchId: "b",
        totalCost: "10.00",
        currency: "CNY",
        receivedAt: "2026-01-01",
        initialQuantity: "10",
        adjustments: [{ amount: "-30.00", currency: "CNY", incurredOn: "2026-01-02" }]
      }
    ];
    const result = computeProjectCost("CNY", negativeBatches, [{ consumptionId: "x", batchId: "b", usedQuantity: "5", wasteQuantity: "0" }], fixedRate({}));
    expect(result.warnings).toHaveLength(1);
    expect(result.lines[0]?.batchTotalCostBase).toBe("-20.00");
    expect(result.lines[0]?.usedCostBase).toBe("-10.00");
  });
});
