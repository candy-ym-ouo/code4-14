import {
  allocateByWeights,
  convertMoney,
  moneyFromScaled,
  moneyToScaled,
  rateToScaled,
  unitCostFromScaled
} from "@handcraft/contracts";

// 与 packages/contracts 中数量定点数保持一致（numeric(18,6) → 1e6）。
const QUANTITY_SCALE = 1_000_000n;
const UNIT_COST_SCALE = 10n ** 10n;

export type CostLayerInput = {
  /** 层级金额（原币，允许负数，用于更正层） */
  amount: string;
  currency: string;
  /** 该层分摊基数对应的数量（库存单位，1e6 定点字符串） */
  quantityBasis: string;
  /** 层级说明，如 OPENING / ADJUSTMENT:<id> */
  reference: string;
};

export type RateMap = Map<string, { rate: string; effectiveFrom: string }>;

export type CostAllocationInput = {
  usedQuantity: string;
  wasteQuantity: string;
  /** 消耗时点的加权平均单位成本各构成层 */
  layers: CostLayerInput[];
  /** 批次原币币种（用于凭证展示；为 null 表示批次未登记币种） */
  batchCurrency: string | null;
  rates: RateMap;
  baseCurrency: string;
  /** 消耗发生日期（ISO yyyy-mm-dd），用于选择汇率版本 */
  valueDate: string;
};

export type CostAllocation = {
  usedQuantity: string;
  wasteQuantity: string;
  totalQuantity: string;
  unitCostOrig: string;
  usedCostOrig: string;
  wasteCostOrig: string;
  totalCostOrig: string;
  currency: string | null;
  exchangeRate: string | null;
  exchangeRateDate: string | null;
  unitCostBase: string;
  usedCostBase: string;
  wasteCostBase: string;
  totalCostBase: string;
  basis: CostBasis;
};

export type LayerBasis = {
  reference: string;
  currency: string;
  amount: string;
  quantityBasis: string;
  rate: string | null;
  rateDate: string | null;
  unitCostBase: string;
};

export type CostBasis = {
  valueDate: string;
  layers: LayerBasis[];
  missingRates: string[];
  fingerprint?: string;
};

function quantityToScaled(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) throw new Error("INVALID_QUANTITY");
  const fraction = (match[2] ?? "").padEnd(6, "0");
  return BigInt(match[1] ?? "0") * QUANTITY_SCALE + BigInt(fraction || "0");
}

function quantityFromScaled(value: bigint): string {
  const whole = value / QUANTITY_SCALE;
  const fraction = (value % QUANTITY_SCALE).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

export class MissingRateError extends Error {
  constructor(public readonly currencies: string[]) {
    super("MISSING_EXCHANGE_RATE");
    this.name = "MissingRateError";
  }
}

/**
 * 计算一次消耗应承担的采购成本：
 *
 * - 每个成本层（入库采购费 + 历次补录）按其登记时的分摊基数得到单位成本（基准币）；
 * - 按 使用量 / 损耗量 比例分摊到项目，损耗成本同样计入该项目用料成本；
 * - 分项金额之和严格等于总额，尾差由损耗项吸收（无损耗时由使用项吸收）。
 *
 * 纯函数，相同输入恒等输出，保证补录后重算稳定。
 */
export function allocateConsumptionCost(input: CostAllocationInput): CostAllocation {
  const usedWeight = quantityToScaled(input.usedQuantity);
  const wasteWeight = quantityToScaled(input.wasteQuantity);
  const totalWeight = usedWeight + wasteWeight;
  if (totalWeight <= 0n) throw new Error("INVALID_CONSUMPTION_QUANTITY");

  const missingRates: string[] = [];
  const layerBasis: LayerBasis[] = [];
  // 每一层先换算为基准币金额，再按“本次用量 / 层分摊基数”比例分摊。
  // 全程定点整数运算，避免浮点误差。
  let totalBaseScaled = 0n;
  const layerShareBase: bigint[] = [];
  const layerShareOrig: bigint[] = [];
  const layerUnitBase: bigint[] = [];
  let weightedUnitBaseNumerator = 0n;

  for (const layer of input.layers) {
    const basisQuantity = quantityToScaled(layer.quantityBasis);
    if (basisQuantity <= 0n) throw new Error("INVALID_LAYER_BASIS");
    const amountScaled = moneyToScaled(layer.amount);

    let rateScaled: bigint | null = null;
    let rateText: string | null = null;
    let rateDate: string | null = null;
    if (layer.currency === input.baseCurrency) {
      rateScaled = UNIT_COST_SCALE;
      rateText = "1";
      rateDate = input.valueDate;
    } else {
      const rate = input.rates.get(layer.currency);
      if (!rate) {
        missingRates.push(layer.currency);
      } else {
        rateScaled = rateToScaled(rate.rate);
        rateText = rate.rate;
        rateDate = rate.effectiveFrom;
      }
    }

    if (rateScaled !== null) {
      const amountBase = convertMoney(amountScaled, rateScaled);
      // 该层由本次消耗承担的金额（分）：amount × totalWeight / basisQuantity。
      // 先乘后除，余数做半数向上，减少分摊误差。
      const shareBase = halfUpDivide(amountBase * totalWeight, basisQuantity);
      totalBaseScaled += shareBase;
      layerShareBase.push(shareBase);

      // 原币承担额
      const shareOrig = halfUpDivide(amountScaled * totalWeight, basisQuantity);
      layerShareOrig.push(shareOrig);

      // 单位成本（10 位小数）仅用于凭证展示
      const unitBase = (amountBase * UNIT_COST_SCALE) / basisQuantity;
      layerUnitBase.push(unitBase);
      weightedUnitBaseNumerator += unitBase;
    }

    layerBasis.push({
      reference: layer.reference,
      currency: layer.currency,
      amount: layer.amount,
      quantityBasis: layer.quantityBasis,
      rate: rateText,
      rateDate,
      unitCostBase: rateScaled === null
        ? "0.0000000000"
        : unitCostFromScaled((convertMoney(amountScaled, rateScaled) * UNIT_COST_SCALE) / basisQuantity)
    });
  }

  const totalCostBaseScaled = totalBaseScaled;
  const weights = wasteWeight > 0n ? [usedWeight, wasteWeight] : [totalWeight];
  const sharesBase = allocateByWeights(totalCostBaseScaled, weights);
  const usedCostBaseScaled = sharesBase[0]!;
  const wasteCostBaseScaled = wasteWeight > 0n ? sharesBase[1]! : 0n;

  const totalOrigScaled = layerShareOrig.reduce((sum, value) => sum + value, 0n);

  // 原币金额：仅当所有层币种一致时才有单一原币口径；否则原币列留空，由基准币承载。
  const currencies = new Set(input.layers.map((layer) => layer.currency));
  const singleCurrency = currencies.size === 1 ? [...currencies][0]! : null;
  const resolvableInOrig = singleCurrency !== null
    && (singleCurrency === input.baseCurrency || input.rates.has(singleCurrency))
    && missingRates.length === 0;

  let usedCostOrig = moneyFromScaled(0n);
  let wasteCostOrig = moneyFromScaled(0n);
  let totalCostOrig = moneyFromScaled(0n);
  let unitCostOrig = unitCostFromScaled(0n);
  let currency: string | null = null;
  let exchangeRate: string | null = null;
  let exchangeRateDate: string | null = null;

  if (resolvableInOrig) {
    currency = singleCurrency;
    const sharesOrig = allocateByWeights(totalOrigScaled, weights);
    usedCostOrig = moneyFromScaled(sharesOrig[0]!);
    wasteCostOrig = moneyFromScaled(wasteWeight > 0n ? sharesOrig[1]! : 0n);
    totalCostOrig = moneyFromScaled(totalOrigScaled);
    // 原币单位成本（展示用，10 位小数）
    let unitOrigNumerator = 0n;
    for (const layer of input.layers) {
      unitOrigNumerator += (moneyToScaled(layer.amount) * UNIT_COST_SCALE) / quantityToScaled(layer.quantityBasis);
    }
    unitCostOrig = unitCostFromScaled(unitOrigNumerator);
    if (singleCurrency === input.baseCurrency) {
      exchangeRate = "1";
      exchangeRateDate = input.valueDate;
    } else {
      const rate = input.rates.get(singleCurrency)!;
      exchangeRate = rate.rate;
      exchangeRateDate = rate.effectiveFrom;
    }
  } else if (input.batchCurrency) {
    currency = input.batchCurrency;
    if (input.batchCurrency !== input.baseCurrency) {
      const rate = input.rates.get(input.batchCurrency);
      if (rate) {
        exchangeRate = rate.rate;
        exchangeRateDate = rate.effectiveFrom;
      }
    }
  }

  if (missingRates.length > 0) {
    throw new MissingRateError([...new Set(missingRates)]);
  }

  // 展示用加权平均基准币单位成本
  const unitCostBaseScaled = weightedUnitBaseNumerator;

  return {
    usedQuantity: input.usedQuantity,
    wasteQuantity: input.wasteQuantity,
    totalQuantity: quantityFromScaled(totalWeight),
    unitCostOrig,
    usedCostOrig,
    wasteCostOrig,
    totalCostOrig,
    currency,
    exchangeRate,
    exchangeRateDate,
    unitCostBase: unitCostFromScaled(unitCostBaseScaled),
    usedCostBase: moneyFromScaled(usedCostBaseScaled),
    wasteCostBase: moneyFromScaled(wasteCostBaseScaled),
    totalCostBase: moneyFromScaled(totalCostBaseScaled),
    basis: { valueDate: input.valueDate, layers: layerBasis, missingRates: [] }
  };
}

/** 有符号整数除法，余数半数向上（远离 0）。 */
function halfUpDivide(value: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) throw new Error("INVALID_DIVISOR");
  const half = divisor / 2n;
  if (value >= 0n) return (value + half) / divisor;
  return -((-value + half) / divisor);
}

/** 红冲：取消耗凭证金额的相反数，数量与依据保持不变。 */
export function reverseAllocation(allocation: CostAllocation): CostAllocation {
  return {
    ...allocation,
    usedCostOrig: negateMoney(allocation.usedCostOrig),
    wasteCostOrig: negateMoney(allocation.wasteCostOrig),
    totalCostOrig: negateMoney(allocation.totalCostOrig),
    usedCostBase: negateMoney(allocation.usedCostBase),
    wasteCostBase: negateMoney(allocation.wasteCostBase),
    totalCostBase: negateMoney(allocation.totalCostBase)
  };
}

function negateMoney(value: string): string {
  return value.startsWith("-") ? value.slice(1) : value === "0.00" ? value : `-${value}`;
}

/** 重算稳定性依据指纹：计价层 + 汇率版本完全一致时结果不变。 */
export function allocationFingerprint(allocation: CostAllocation): string {
  return JSON.stringify({
    layers: allocation.basis.layers.map((layer) => ({
      reference: layer.reference,
      amount: layer.amount,
      quantityBasis: layer.quantityBasis,
      currency: layer.currency,
      rate: layer.rate,
      rateDate: layer.rateDate
    })),
    usedQuantity: allocation.usedQuantity,
    wasteQuantity: allocation.wasteQuantity
  });
}

export function rateMapFromRows(rows: { currency: string; rate_to_base: string; effective_from: string | Date }[]): RateMap {
  const map: RateMap = new Map();
  for (const row of rows) {
    const date = typeof row.effective_from === "string" ? row.effective_from.slice(0, 10) : row.effective_from.toISOString().slice(0, 10);
    const existing = map.get(row.currency);
    if (!existing || existing.effectiveFrom < date) {
      map.set(row.currency, { rate: row.rate_to_base, effectiveFrom: date });
    }
  }
  return map;
}
