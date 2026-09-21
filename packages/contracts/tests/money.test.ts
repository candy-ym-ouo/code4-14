import { describe, expect, it } from "vitest";
import {
  addMoney,
  allocateByWeights,
  compareMoney,
  convertMoney,
  moneyFromScaled,
  moneyToScaled,
  rateToScaled
} from "../src/index.js";

describe("fixed decimal money operations", () => {
  it("parses and formats cents exactly", () => {
    expect(moneyToScaled("12.34")).toBe(1234n);
    expect(moneyToScaled("-0.01")).toBe(-1n);
    expect(moneyFromScaled(5n)).toBe("0.05");
    expect(addMoney("99.99", "0.02")).toBe("100.01");
    expect(compareMoney("-1.00", "1.00")).toBe(-1);
  });

  it("converts with half-up rounding to cents", () => {
    // 10.00 元 × 7.1823 汇率 = 71.823 → 71.82
    expect(moneyFromScaled(convertMoney(moneyToScaled("10.00"), rateToScaled("7.1823")))).toBe("71.82");
    // 0.01 元 × 0.5 = 0.005 → 半数向上 0.01
    expect(moneyFromScaled(convertMoney(moneyToScaled("0.01"), rateToScaled("0.5")))).toBe("0.01");
    expect(moneyFromScaled(convertMoney(moneyToScaled("-0.01"), rateToScaled("0.5")))).toBe("-0.01");
  });

  it("allocates by weights and keeps the sum exact", () => {
    const shares = allocateByWeights(1000n, [450000000n, 50000000n]);
    expect(shares[0]! + shares[1]!).toBe(1000n);
    // 450g / 50g：900 / 100
    expect(shares).toEqual([900n, 100n]);

    // 尾差由最后一项（损耗）吸收：1.00 元按 1:1:1 → 0.33 + 0.33 + 0.34
    const thirds = allocateByWeights(100n, [1n, 1n, 1n]);
    expect(thirds).toEqual([33n, 33n, 34n]);
    expect(thirds.reduce((sum, value) => sum + value, 0n)).toBe(100n);

    // 负数（更正层）同样守恒
    const negative = allocateByWeights(-100n, [3n, 7n]);
    expect(negative.reduce((sum, value) => sum + value, 0n)).toBe(-100n);
  });
});
