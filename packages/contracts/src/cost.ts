import { z } from "zod";

/**
 * 项目用料成本核算核心。
 *
 * 所有金额与汇率运算都使用 bigint 定点数，不经过浮点：
 * - 金额：2 位小数（分）
 * - 汇率：8 位小数
 * - 数量：6 位小数（与库存数量一致）
 * - 单位成本快照：8 位小数
 *
 * 相同输入必然产生相同输出（重算稳定），舍入规则为"绝对值半进"（half away from zero）。
 */

const MONEY_SCALE = 100n;
const MONEY_DECIMALS = 2;
const RATE_SCALE = 100_000_000n;
const RATE_DECIMALS = 8;
const QUANTITY_SCALE = 1_000_000n;
const QUANTITY_DECIMALS = 6;
const UNIT_COST_DECIMALS = 8;

function parseFixed(value: string, scale: bigint, decimals: number): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match || (match[3]?.length ?? 0) > decimals) throw new Error("INVALID_FIXED_DECIMAL");
  const whole = BigInt(match[2] ?? "0");
  const fraction = (match[3] ?? "").padEnd(decimals, "0");
  const scaled = whole * scale + BigInt(fraction || "0");
  return match[1] === "-" ? -scaled : scaled;
}

function formatFixed(scaled: bigint, scale: bigint, decimals: number): string {
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** 分母必须为正的整除，余数按"绝对值半进"舍入。 */
function divRound(denominator: bigint, numerator: bigint): bigint {
  if (denominator <= 0n) throw new Error("INVALID_DIVISOR");
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const doubled = (remainder < 0n ? -remainder : remainder) * 2n;
  if (doubled >= denominator) return quotient + (remainder < 0n ? -1n : 1n);
  return quotient;
}

function parseMoney(value: string): bigint {
  return parseFixed(value, MONEY_SCALE, MONEY_DECIMALS);
}

function parseRate(value: string): bigint {
  return parseFixed(value, RATE_SCALE, RATE_DECIMALS);
}

function parseQuantity(value: string): bigint {
  return parseFixed(value, QUANTITY_SCALE, QUANTITY_DECIMALS);
}

function formatMoney(scaled: bigint): string {
  return formatFixed(scaled, MONEY_SCALE, MONEY_DECIMALS);
}

export const currencyCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, "币种必须是 3 位字母代码")
  .transform((value) => value.toUpperCase());

export const signedMoneyAmount = z
  .string()
  .trim()
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/, "金额必须是最多 2 位小数的十进制数");

export const exchangeRateValue = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/, "汇率必须是最多 8 位小数的正数")
  .refine((value) => parseRate(value) > 0n, "汇率必须大于 0");

export const costSettingsInputSchema = z.object({
  baseCurrency: currencyCode
});

export const exchangeRateInputSchema = z.object({
  currency: currencyCode,
  rateToBase: exchangeRateValue,
  effectiveOn: z.string().date(),
  notes: z.string().trim().max(1000).nullable().optional()
});

export const costAdjustmentInputSchema = z.object({
  feeType: z.string().trim().min(1, "费用类型不能为空").max(40),
  amount: signedMoneyAmount.refine((value) => parseMoney(value) !== 0n, "金额不能为 0"),
  currency: currencyCode,
  incurredOn: z.string().date(),
  notes: z.string().trim().max(1000).nullable().optional()
});

export function addMoney(left: string, right: string): string {
  return formatMoney(parseMoney(left) + parseMoney(right));
}

export function compareMoney(left: string, right: string): number {
  const a = parseMoney(left);
  const b = parseMoney(right);
  return a === b ? 0 : a > b ? 1 : -1;
}

/** 把一笔 2 位小数金额按 8 位小数汇率换算成本位币，结果舍入到分。 */
export function convertMoneyToBase(amount: string, rateToBase: string): string {
  const scaled = parseMoney(amount) * parseRate(rateToBase);
  return formatMoney(divRound(RATE_SCALE, scaled));
}

/** 按数量占比分摊金额：totalBase × partQuantity ÷ wholeQuantity，结果舍入到分。 */
export function prorateAmount(totalBase: string, partQuantity: string, wholeQuantity: string): string {
  const whole = parseQuantity(wholeQuantity);
  if (whole <= 0n) throw new Error("INVALID_QUANTITY");
  return formatMoney(divRound(whole, parseMoney(totalBase) * parseQuantity(partQuantity)));
}

/** unit_scaled8 = total_scaled2 × 10^12 ÷ qty_scaled6（见文件头部的精度约定）。 */
const UNIT_COST_SCALE_FACTOR = 1_000_000_000_000n;

/** 单位成本快照（8 位小数）：totalBase ÷ wholeQuantity。 */
export function unitCostBase(totalBase: string, wholeQuantity: string): string {
  const whole = parseQuantity(wholeQuantity);
  if (whole <= 0n) throw new Error("INVALID_QUANTITY");
  const scaled = divRound(whole, parseMoney(totalBase) * UNIT_COST_SCALE_FACTOR);
  return formatFixed(scaled, RATE_SCALE, UNIT_COST_DECIMALS);
}

export type CostAdjustmentEntry = {
  amount: string;
  currency: string;
  incurredOn: string;
};

export type CostBatchInput = {
  batchId: string;
  totalCost: string | null;
  currency: string | null;
  receivedAt: string;
  initialQuantity: string;
  adjustments: CostAdjustmentEntry[];
};

export type CostConsumptionInput = {
  consumptionId: string;
  batchId: string;
  usedQuantity: string;
  wasteQuantity: string;
};

export type ResolvedRate = {
  rate: string;
  rateId: string | null;
};

/** 汇率解析器：返回 null 表示该币种在该日期之前没有可用汇率。 */
export type RateResolver = (currency: string, onDate: string) => ResolvedRate | null;

export type ComputedCostLine = {
  consumptionId: string;
  batchId: string;
  usedQuantity: string;
  wasteQuantity: string;
  currency: string | null;
  priced: boolean;
  batchTotalCostBase: string | null;
  unitCostBase: string | null;
  fxRate: string | null;
  fxRateId: string | null;
  usedCostBase: string | null;
  wasteCostBase: string | null;
  totalCostBase: string | null;
};

export type MissingRate = {
  currency: string;
  onDate: string;
};

export type ProjectCostComputation = {
  baseCurrency: string;
  lines: ComputedCostLine[];
  missingRates: MissingRate[];
  warnings: string[];
  totals: {
    usedCostBase: string;
    wasteCostBase: string;
    totalCostBase: string;
    pricedLineCount: number;
    unpricedLineCount: number;
  };
};

function unpricedLine(consumption: CostConsumptionInput, currency: string | null): ComputedCostLine {
  return {
    consumptionId: consumption.consumptionId,
    batchId: consumption.batchId,
    usedQuantity: consumption.usedQuantity,
    wasteQuantity: consumption.wasteQuantity,
    currency,
    priced: false,
    batchTotalCostBase: null,
    unitCostBase: null,
    fxRate: null,
    fxRateId: null,
    usedCostBase: null,
    wasteCostBase: null,
    totalCostBase: null
  };
}

/**
 * 计算一个项目全部有效消耗的成本明细。
 *
 * 分摊规则：
 * - 批次总成本（本位币）= 批次货款 × 入库日汇率 + Σ 每笔采购费 × 各自发生日汇率；
 * - 每条消耗按"消耗数量 ÷ 批次初始数量"分摊批次总成本；
 * - 实际使用与损耗分别分摊、分别列示，行总额 = 两者之和；
 * - 批次币种等于本位币时汇率恒为 1，不依赖汇率表。
 */
export function computeProjectCost(
  baseCurrency: string,
  batches: CostBatchInput[],
  consumptions: CostConsumptionInput[],
  resolveRate: RateResolver
): ProjectCostComputation {
  const batchMap = new Map(batches.map((batch) => [batch.batchId, batch]));
  const missingRates = new Map<string, MissingRate>();
  const warnings: string[] = [];
  const lines: ComputedCostLine[] = [];
  let usedTotal = 0n;
  let wasteTotal = 0n;
  let pricedLineCount = 0;
  let unpricedLineCount = 0;

  const rateFor = (currency: string, onDate: string): ResolvedRate | null => {
    if (currency === baseCurrency) return { rate: "1", rateId: null };
    const resolved = resolveRate(currency, onDate);
    if (!resolved) missingRates.set(`${currency}@${onDate}`, { currency, onDate });
    return resolved;
  };

  for (const consumption of consumptions) {
    const batch = batchMap.get(consumption.batchId);
    if (!batch) throw new Error(`COST_BATCH_MISSING:${consumption.batchId}`);
    const hasCostData = batch.totalCost !== null || batch.adjustments.length > 0;
    if (!hasCostData) {
      lines.push(unpricedLine(consumption, batch.currency));
      unpricedLineCount += 1;
      continue;
    }

    let batchTotalScaled = 0n;
    let fxRate: string | null = null;
    let fxRateId: string | null = null;
    let missingRate = false;
    let invalid = false;

    if (batch.totalCost !== null) {
      if (!batch.currency) {
        warnings.push(`批次 ${batch.batchId} 记录了采购成本但缺少币种，相关消耗按未定价处理`);
        invalid = true;
      } else {
        const rate = rateFor(batch.currency, batch.receivedAt);
        if (!rate) {
          missingRate = true;
        } else {
          fxRate = formatFixed(parseRate(rate.rate), RATE_SCALE, RATE_DECIMALS);
          fxRateId = rate.rateId;
          batchTotalScaled += parseMoney(convertMoneyToBase(batch.totalCost, rate.rate));
        }
      }
    }

    if (!invalid) {
      for (const adjustment of batch.adjustments) {
        const rate = rateFor(adjustment.currency, adjustment.incurredOn);
        if (!rate) {
          missingRate = true;
          continue;
        }
        batchTotalScaled += parseMoney(convertMoneyToBase(adjustment.amount, rate.rate));
      }
    }

    if (invalid || missingRate) {
      lines.push(unpricedLine(consumption, batch.currency));
      unpricedLineCount += 1;
      continue;
    }

    if (batchTotalScaled < 0n) {
      warnings.push(`批次 ${batch.batchId} 的成本合计为负数（折让超过采购成本），已按实际数值核算`);
    }

    const batchTotalCostBase = formatMoney(batchTotalScaled);
    const usedCostBase = prorateAmount(batchTotalCostBase, consumption.usedQuantity, batch.initialQuantity);
    const wasteCostBase = prorateAmount(batchTotalCostBase, consumption.wasteQuantity, batch.initialQuantity);
    const lineTotal = formatMoney(parseMoney(usedCostBase) + parseMoney(wasteCostBase));
    usedTotal += parseMoney(usedCostBase);
    wasteTotal += parseMoney(wasteCostBase);
    pricedLineCount += 1;

    lines.push({
      consumptionId: consumption.consumptionId,
      batchId: consumption.batchId,
      usedQuantity: consumption.usedQuantity,
      wasteQuantity: consumption.wasteQuantity,
      currency: batch.currency,
      priced: true,
      batchTotalCostBase,
      unitCostBase: unitCostBase(batchTotalCostBase, batch.initialQuantity),
      fxRate,
      fxRateId,
      usedCostBase,
      wasteCostBase,
      totalCostBase: lineTotal
    });
  }

  return {
    baseCurrency,
    lines,
    missingRates: [...missingRates.values()],
    warnings,
    totals: {
      usedCostBase: formatMoney(usedTotal),
      wasteCostBase: formatMoney(wasteTotal),
      totalCostBase: formatMoney(usedTotal + wasteTotal),
      pricedLineCount,
      unpricedLineCount
    }
  };
}
