import { randomUUID } from "node:crypto";
import type { DbClient } from "./db.js";
import { AppError } from "./errors.js";
import {
  allocateConsumptionCost,
  allocationFingerprint,
  rateMapFromRows,
  reverseAllocation,
  type CostAllocation,
  type CostLayerInput
} from "./costing.js";
import { moneyToScaled } from "@handcraft/contracts";
import { writeAudit } from "./audit.js";

export type VoucherStatus = "DRAFT" | "ACTIVE" | "SUPERSEDED" | "REVERSED" | "CONFIRMED";

export type VoucherRow = Record<string, unknown> & {
  id: string;
  root_voucher_id: string;
  supersedes_voucher_id: string | null;
  version: number;
  status: VoucherStatus;
  event_type: "CONSUMPTION" | "REVERSAL";
  consumption_id: string;
  project_id: string;
  batch_id: string;
  used_quantity: string;
  waste_quantity: string;
  total_quantity: string;
  batch_initial_quantity: string;
  batch_remaining_before: string;
  total_cost_base: string;
  used_cost_base: string;
  waste_cost_base: string;
  exchange_rate: string | null;
  exchange_rate_date: string | null;
  basis: { fingerprint?: string; layers?: unknown[] } | Record<string, unknown>;
};

export type RateRow = { currency: string; rate_to_base: string; effective_from: string | Date };

/** 查询某日生效的全部汇率（每币种取 effective_from <= asOf 的最新版本）。 */
export async function loadRatesAsOf(client: DbClient, asOf: string): Promise<Map<string, { rate: string; effectiveFrom: string }>> {
  const result = await client.query<RateRow>(
    `SELECT DISTINCT ON (currency) currency, rate_to_base::text AS rate_to_base, effective_from
       FROM currency_rates
      WHERE effective_from <= $1::date
      ORDER BY currency, effective_from DESC`,
    [asOf]
  );
  return rateMapFromRows(result.rows);
}

export async function getBaseCurrency(client: DbClient): Promise<string> {
  const result = await client.query<{ base_currency: string }>("SELECT base_currency FROM costing_settings WHERE id = true");
  return result.rows[0]?.base_currency ?? "CNY";
}

export type BatchCostInfo = {
  initialQuantity: string;
  remainingBefore: string;
  totalCost: string | null;
  currency: string | null;
};

/**
 * 装载批次在指定时点适用的成本层：
 * - OPENING 层：入库采购费，分摊基数 = 入库初始数量；
 * - ADJUSTMENT 层：每次补录/更正，分摊基数 = 补录发生时批次剩余数量；
 *   仅 effective_from <= asOf 的层参与（补录未来日期不会改写更早的凭证）。
 */
export async function loadCostLayers(
  client: DbClient,
  batchId: string,
  asOf: string,
  provided?: BatchCostInfo
): Promise<{ info: BatchCostInfo; layers: CostLayerInput[] }> {
  let info: BatchCostInfo;
  if (provided) {
    info = provided;
  } else {
    const result = await client.query<{
      initial_quantity: string; remaining_quantity: string; total_cost: string | null; currency: string | null;
    }>(
      `SELECT initial_quantity::text AS initial_quantity, remaining_quantity::text AS remaining_quantity,
              total_cost::text AS total_cost, currency
         FROM batches WHERE id = $1`,
      [batchId]
    );
    if (!result.rows[0]) throw new AppError(404, "NOT_FOUND", "批次不存在");
    const row = result.rows[0];
    info = {
      initialQuantity: row.initial_quantity,
      remainingBefore: row.remaining_quantity,
      totalCost: row.total_cost,
      currency: row.currency
    };
  }

  const layers: CostLayerInput[] = [];
  if (info.totalCost !== null && moneyToScaled(info.totalCost) !== 0n) {
    layers.push({
      amount: info.totalCost,
      currency: info.currency ?? "CNY",
      quantityBasis: info.initialQuantity,
      reference: "OPENING"
    });
  }
  const adjustments = await client.query<{ id: string; amount: string; currency: string; remaining: string }>(
    `SELECT id, amount::text AS amount, currency, remaining_quantity_at_entry::text AS remaining
       FROM batch_cost_adjustments
      WHERE batch_id = $1 AND effective_from <= $2::date
      ORDER BY effective_from, created_at`,
    [batchId, asOf]
  );
  for (const adjustment of adjustments.rows) {
    layers.push({
      amount: adjustment.amount,
      currency: adjustment.currency,
      quantityBasis: adjustment.remaining,
      reference: `ADJUSTMENT:${adjustment.id}`
    });
  }
  return { info, layers };
}

export type ConsumptionRef = {
  id: string;
  projectId: string;
  batchId: string;
  usedQuantity: string;
  wasteQuantity: string;
  totalQuantity: string;
};

type ResolveResult = {
  allocation: CostAllocation;
  status: "DRAFT" | "ACTIVE";
  baseCurrency: string;
};

/** 按当前成本层 + 汇率版本计算；缺成本或缺汇率时解析为 DRAFT（金额留空，不产出错误数字）。 */
async function resolveAllocation(
  client: DbClient,
  consumption: ConsumptionRef,
  valueDate: string,
  batchInfo: BatchCostInfo
): Promise<ResolveResult> {
  const [baseCurrency, rates, { layers }] = await Promise.all([
    getBaseCurrency(client),
    loadRatesAsOf(client, valueDate),
    loadCostLayers(client, consumption.batchId, valueDate, batchInfo)
  ]);
  if (layers.length === 0) {
    return { allocation: draftAllocation(consumption, valueDate, baseCurrency), status: "DRAFT", baseCurrency };
  }
  try {
    const allocation = allocateConsumptionCost({
      usedQuantity: consumption.usedQuantity,
      wasteQuantity: consumption.wasteQuantity,
      layers,
      batchCurrency: batchInfo.currency,
      rates,
      baseCurrency,
      valueDate
    });
    return { allocation, status: "ACTIVE", baseCurrency };
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "MISSING_EXCHANGE_RATE") throw error;
    return { allocation: draftAllocation(consumption, valueDate, baseCurrency, layers[0]?.currency), status: "DRAFT", baseCurrency };
  }
}

function draftAllocation(
  consumption: ConsumptionRef,
  valueDate: string,
  _baseCurrency: string,
  currency: string | null = null
): CostAllocation {
  return {
    usedQuantity: consumption.usedQuantity,
    wasteQuantity: consumption.wasteQuantity,
    totalQuantity: consumption.totalQuantity,
    unitCostOrig: "0.0000000000",
    usedCostOrig: "0.00",
    wasteCostOrig: "0.00",
    totalCostOrig: "0.00",
    currency,
    exchangeRate: null,
    exchangeRateDate: null,
    unitCostBase: "0.0000000000",
    usedCostBase: "0.00",
    wasteCostBase: "0.00",
    totalCostBase: "0.00",
    basis: { valueDate, layers: [], missingRates: [] }
  };
}

function withFingerprint(allocation: CostAllocation): CostAllocation {
  return { ...allocation, basis: { ...allocation.basis, fingerprint: allocationFingerprint(allocation) } };
}

type InsertParams = {
  eventType: "CONSUMPTION" | "REVERSAL";
  consumption: ConsumptionRef;
  allocation: CostAllocation;
  baseCurrency: string;
  batchInitialQuantity: string;
  batchRemainingBefore: string;
  version: number;
  rootVoucherId?: string;
  supersedesVoucherId?: string | null;
  status: "DRAFT" | "ACTIVE";
  remark?: string | null;
  actorUserId: string;
};

async function insertVoucher(client: DbClient, params: InsertParams): Promise<VoucherRow> {
  const id = randomUUID();
  const result = await client.query<VoucherRow>(
    `INSERT INTO material_cost_vouchers(
        id, root_voucher_id, supersedes_voucher_id, version, event_type, consumption_id, project_id, batch_id,
        status, used_quantity, waste_quantity, total_quantity, batch_initial_quantity, batch_remaining_before,
        unit_cost_orig, used_cost_orig, waste_cost_orig, total_cost_orig, currency, exchange_rate, exchange_rate_date,
        unit_cost_base, used_cost_base, waste_cost_base, total_cost_base, base_currency, basis, remark, created_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9::cost_voucher_status, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20, $21::date,
        $22, $23, $24, $25, $26, $27::jsonb, $28, $29
      ) RETURNING *`,
    [
      id,
      params.rootVoucherId ?? id,
      params.supersedesVoucherId ?? null,
      params.version,
      params.eventType,
      params.consumption.id,
      params.consumption.projectId,
      params.consumption.batchId,
      params.status,
      params.consumption.usedQuantity,
      params.consumption.wasteQuantity,
      params.consumption.totalQuantity,
      params.batchInitialQuantity,
      params.batchRemainingBefore,
      params.allocation.unitCostOrig,
      params.allocation.usedCostOrig,
      params.allocation.wasteCostOrig,
      params.allocation.totalCostOrig,
      params.allocation.currency,
      params.allocation.exchangeRate,
      params.allocation.exchangeRateDate,
      params.allocation.unitCostBase,
      params.allocation.usedCostBase,
      params.allocation.wasteCostBase,
      params.allocation.totalCostBase,
      params.baseCurrency,
      JSON.stringify(withFingerprint(params.allocation).basis),
      params.remark ?? null,
      params.actorUserId
    ]
  );
  return result.rows[0]!;
}

async function transitionVoucher(
  client: DbClient,
  voucherId: string,
  status: "SUPERSEDED" | "REVERSED" | "CONFIRMED" | "ACTIVE"
): Promise<void> {
  await client.query(
    `UPDATE material_cost_vouchers
        SET status = $1::cost_voucher_status,
            confirmed_at = CASE WHEN $1::cost_voucher_status = 'CONFIRMED' THEN now() ELSE confirmed_at END
      WHERE id = $2`,
    [status, voucherId]
  );
}

/** 由库存流水还原消耗前余额（CONSUMPTION 流水的 before_quantity）。 */
export async function remainingBeforeConsumption(client: DbClient, consumptionId: string): Promise<string> {
  const result = await client.query<{ before_quantity: string }>(
    `SELECT before_quantity::text AS before_quantity FROM stock_movements
      WHERE reference_type = 'CONSUMPTION' AND reference_id = $1 LIMIT 1`,
    [consumptionId]
  );
  return result.rows[0]?.before_quantity ?? "0.000000";
}

function summarizeVoucher(voucher: VoucherRow): Record<string, unknown> {
  return {
    id: voucher.id,
    rootVoucherId: voucher.root_voucher_id,
    version: voucher.version,
    eventType: voucher.event_type,
    status: voucher.status,
    totalCostBase: voucher.total_cost_base,
    currency: voucher.currency
  };
}

/**
 * 刷新某条消耗的凭证链（CONSUMPTION 链；已撤销时还有 REVERSAL 链）。
 *
 * 模型：
 * - 消耗链承载本次计算金额；撤销时红冲链承载其镜像（取负），两链当前版本净额恒为 0；
 * - DRAFT（缺成本或缺汇率）时两链都挂 0 元 DRAFT，补录后重算一起翻为 ACTIVE；
 * - CONFIRMED 的当前凭证不会被自动替换，必须通过显式重开；
 * - 计价依据指纹与状态都未变时不产生新版本（unchanged），重复重算稳定。
 */
export async function refreshVoucherChain(
  client: DbClient,
  params: {
    consumption: ConsumptionRef;
    valueDate: string;
    batchInfo: BatchCostInfo;
    actorUserId: string;
    requestId?: string;
    reversalReason?: string;
    action?: "CREATE" | "REVERSE" | "RECOMPUTE" | "REOPEN";
    reopen?: { currentId: string; reason: string };
    remark?: string | null;
  }
): Promise<{ outcome: "created" | "unchanged" | "skipped"; voucher?: VoucherRow; reversalVoucher?: VoucherRow | null }> {
  const { allocation, status, baseCurrency } = await resolveAllocation(client, params.consumption, params.valueDate, params.batchInfo);
  const reversalAllocation = status === "ACTIVE" ? reverseAllocation(allocation) : null;
  const existing = await client.query<VoucherRow>(
    `SELECT * FROM material_cost_vouchers WHERE consumption_id = $1 ORDER BY created_at, version`,
    [params.consumption.id]
  );
  const rows = existing.rows;
  const reversed = params.reversalReason !== undefined;

  if (rows.length === 0) {
    const voucher = await insertVoucher(client, {
      eventType: "CONSUMPTION",
      consumption: params.consumption,
      allocation,
      baseCurrency,
      batchInitialQuantity: params.batchInfo.initialQuantity,
      batchRemainingBefore: params.batchInfo.remainingBefore,
      version: 1,
      status,
      actorUserId: params.actorUserId
    });
    let reversalVoucher: VoucherRow | null = null;
    if (reversed) {
      reversalVoucher = await insertVoucher(client, {
        eventType: "REVERSAL",
        consumption: params.consumption,
        allocation: reversalAllocation ?? draftAllocation(params.consumption, params.valueDate, baseCurrency),
        baseCurrency,
        batchInitialQuantity: params.batchInfo.initialQuantity,
        batchRemainingBefore: params.batchInfo.remainingBefore,
        version: 1,
        status,
        remark: params.reversalReason,
        actorUserId: params.actorUserId
      });
    }
    await writeAudit(client, {
      actorUserId: params.actorUserId,
      action: reversed ? "COST_VOUCHER_REVERSE" : "COST_VOUCHER_CREATE",
      entityType: "MATERIAL_COST_VOUCHER",
      entityId: voucher.id,
      afterData: { vouchers: [voucher, reversalVoucher].filter(Boolean).map((item) => summarizeVoucher(item!)) },
      requestId: params.requestId
    });
    return { outcome: "created", voucher, reversalVoucher };
  }

  const consumptionCurrent = rows.find(
    (row) => row.event_type === "CONSUMPTION" && ["DRAFT", "ACTIVE", "CONFIRMED"].includes(row.status)
  )!;
  const reversalCurrent = rows.find(
    (row) => row.event_type === "REVERSAL" && ["DRAFT", "ACTIVE", "CONFIRMED"].includes(row.status)
  );

  const isReopen = params.reopen?.currentId === consumptionCurrent.id;

  // 已确认（结转/报账）的当前凭证不会被自动替换，必须显式重开。
  if (consumptionCurrent.status === "CONFIRMED" && !isReopen) {
    return { outcome: "skipped" };
  }
  if (params.action === "REVERSE" && reversalCurrent?.status === "CONFIRMED") {
    throw new AppError(409, "VOUCHER_CONFIRMED", "该消耗的红冲凭证已确认，如需更正请先显式重开");
  }

  const consumptionChanged = isReopen || !fingerprintsEqual(consumptionCurrent, allocation) || consumptionCurrent.status !== status;

  // 撤销当下若还没有红冲链，必须新增。
  const reversalJustAdded = reversed && !reversalCurrent;
  // 红冲链当前版本必须与消耗链同状态、金额镜像。
  const reversalChanged = Boolean(
    reversalCurrent
    && reversalCurrent.status !== "CONFIRMED"
    && (reversalCurrent.status !== status || (reversalAllocation && !reversalMirrors(reversalCurrent, reversalAllocation)))
  );

  if (!consumptionChanged && !reversalJustAdded && !reversalChanged) {
    return { outcome: "unchanged", voucher: consumptionCurrent, reversalVoucher: reversalCurrent ?? null };
  }

  // 新消耗版本
  let voucher = consumptionCurrent;
  if (consumptionChanged) {
    const nextVersion = nextVersionFor(rows, consumptionCurrent.root_voucher_id);
    voucher = await insertVoucher(client, {
      eventType: "CONSUMPTION",
      consumption: params.consumption,
      allocation,
      baseCurrency,
      batchInitialQuantity: params.batchInfo.initialQuantity,
      batchRemainingBefore: params.batchInfo.remainingBefore,
      version: nextVersion,
      rootVoucherId: consumptionCurrent.root_voucher_id,
      supersedesVoucherId: consumptionCurrent.id,
      status,
      remark: params.remark ?? (isReopen && params.reopen ? params.reopen.reason : null),
      actorUserId: params.actorUserId
    });
    await transitionVoucher(client, consumptionCurrent.id, "SUPERSEDED");
  }

  // 红冲版本：新增链或追加镜像版本
  let reversalVoucher: VoucherRow | null = reversalCurrent ?? null;
  if (reversalJustAdded) {
    reversalVoucher = await insertVoucher(client, {
      eventType: "REVERSAL",
      consumption: params.consumption,
      allocation: reversalAllocation ?? draftAllocation(params.consumption, params.valueDate, baseCurrency),
      baseCurrency,
      batchInitialQuantity: params.batchInfo.initialQuantity,
      batchRemainingBefore: params.batchInfo.remainingBefore,
      version: 1,
      status,
      remark: params.reversalReason,
      actorUserId: params.actorUserId
    });
  } else if (reversalCurrent && (reversalChanged || consumptionChanged)) {
    const reversalNext = nextVersionFor(rows, reversalCurrent.root_voucher_id);
    reversalVoucher = await insertVoucher(client, {
      eventType: "REVERSAL",
      consumption: params.consumption,
      allocation: reversalAllocation ?? draftAllocation(params.consumption, params.valueDate, baseCurrency),
      baseCurrency,
      batchInitialQuantity: params.batchInfo.initialQuantity,
      batchRemainingBefore: params.batchInfo.remainingBefore,
      version: reversalNext,
      rootVoucherId: reversalCurrent.root_voucher_id,
      supersedesVoucherId: reversalCurrent.id,
      status,
      remark: params.remark ?? null,
      actorUserId: params.actorUserId
    });
    await transitionVoucher(client, reversalCurrent.id, "SUPERSEDED");
  }

  await writeAudit(client, {
    actorUserId: params.actorUserId,
    action: isReopen
      ? "COST_VOUCHER_REOPEN"
      : reversed
        ? "COST_VOUCHER_REVERSE"
        : "COST_VOUCHER_RECOMPUTE",
    entityType: "MATERIAL_COST_VOUCHER",
    entityId: voucher.id,
    beforeData: summarizeVoucher(consumptionCurrent),
    afterData: { voucher: summarizeVoucher(voucher), reversal: reversalVoucher ? summarizeVoucher(reversalVoucher) : null },
    requestId: params.requestId
  });

  return { outcome: "created", voucher, reversalVoucher };
}

function nextVersionFor(rows: VoucherRow[], rootVoucherId: string): number {
  const versions = rows.filter((row) => row.root_voucher_id === rootVoucherId).map((row) => row.version);
  return versions.reduce((max, value) => Math.max(max, value), 0) + 1;
}

function reversalMirrors(current: VoucherRow, reversal: CostAllocation): boolean {
  return current.used_cost_base === reversal.usedCostBase
    && current.waste_cost_base === reversal.wasteCostBase
    && current.total_cost_base === reversal.totalCostBase;
}

function fingerprintsEqual(current: VoucherRow, allocation: CostAllocation): boolean {
  const stored = (current.basis as { fingerprint?: string }).fingerprint;
  if (!stored) {
    return current.total_cost_base === allocation.totalCostBase
      && current.used_cost_base === allocation.usedCostBase
      && current.waste_cost_base === allocation.wasteCostBase
      && current.exchange_rate === (allocation.exchangeRate ?? null)
      && current.exchange_rate_date === (allocation.exchangeRateDate ?? null);
  }
  return stored === allocationFingerprint(allocation);
}

export type RecomputeSummary = {
  created: number;
  unchanged: number;
  skipped: number;
  drafts: number;
  reopened: number;
  voucherIds: string[];
};

/** 按批次/项目/消耗范围重算所有凭证链。CONFIRMED 默认跳过。 */
export async function recomputeVouchers(
  client: DbClient,
  scope: { batchId?: string; projectId?: string; consumptionIds?: string[] },
  options: {
    actorUserId: string;
    requestId?: string;
    reopen?: { currentId: string; reason: string };
    remark?: string | null;
  }
): Promise<RecomputeSummary> {
  const filters: string[] = [];
  const values: unknown[] = [];
  if (scope.batchId) {
    values.push(scope.batchId);
    filters.push(`c.batch_id = $${values.length}::uuid`);
  }
  if (scope.projectId) {
    values.push(scope.projectId);
    filters.push(`c.project_id = $${values.length}::uuid`);
  }
  if (scope.consumptionIds && scope.consumptionIds.length > 0) {
    values.push(scope.consumptionIds);
    filters.push(`c.id = ANY($${values.length}::uuid[])`);
  }
  if (filters.length === 0) throw new AppError(422, "INVALID_SCOPE", "重算必须指定批次、项目或消耗范围");
  if (scope.batchId) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('costing:batch:' || $1, 0))", [scope.batchId]);
  }

  const consumptions = await client.query<{
    id: string; project_id: string; batch_id: string;
    used_quantity: string; waste_quantity: string; total_quantity: string;
    consumed_at: string; status: string;
    initial_quantity: string; total_cost: string | null; currency: string | null;
  }>(
    `SELECT c.id, c.project_id, c.batch_id, c.used_quantity::text AS used_quantity,
            c.waste_quantity::text AS waste_quantity, c.total_quantity::text AS total_quantity,
            c.consumed_at::text AS consumed_at, c.status,
            b.initial_quantity::text AS initial_quantity,
            b.total_cost::text AS total_cost, b.currency
       FROM consumptions c JOIN batches b ON b.id = c.batch_id
      WHERE ${filters.join(" AND ")}
      ORDER BY c.consumed_at, c.created_at`,
    values
  );

  const summary: RecomputeSummary = { created: 0, unchanged: 0, skipped: 0, drafts: 0, reopened: 0, voucherIds: [] };
  for (const row of consumptions.rows) {
    const before = await remainingBeforeConsumption(client, row.id);
    const result = await refreshVoucherChain(client, {
      consumption: {
        id: row.id, projectId: row.project_id, batchId: row.batch_id,
        usedQuantity: row.used_quantity, wasteQuantity: row.waste_quantity, totalQuantity: row.total_quantity
      },
      valueDate: row.consumed_at.slice(0, 10),
      batchInfo: { initialQuantity: row.initial_quantity, remainingBefore: before, totalCost: row.total_cost, currency: row.currency },
      actorUserId: options.actorUserId,
      requestId: options.requestId,
      action: options.reopen ? "REOPEN" : "RECOMPUTE",
      reopen: options.reopen,
      remark: options.remark ?? null,
      ...(row.status === "REVERSED" ? { reversalReason: "历史撤销重算" } : {})
    });
    if (result.outcome === "skipped") summary.skipped += 1;
    else if (result.outcome === "unchanged") summary.unchanged += 1;
    else {
      summary.created += 1;
      if (result.voucher?.status === "DRAFT") summary.drafts += 1;
      if (options.reopen && result.outcome === "created") summary.reopened += 1;
      if (result.voucher) summary.voucherIds.push(result.voucher.id);
    }
  }
  return summary;
}

/** 确认（结转/报账）当前凭证。DRAFT 不允许确认。 */
export async function confirmVoucher(
  client: DbClient,
  voucherId: string,
  actorUserId: string,
  requestId: string | undefined,
  remark?: string | null
): Promise<VoucherRow> {
  const result = await client.query<VoucherRow>(
    `SELECT * FROM material_cost_vouchers WHERE id = $1 FOR UPDATE`,
    [voucherId]
  );
  const voucher = result.rows[0];
  if (!voucher) throw new AppError(404, "NOT_FOUND", "成本凭证不存在");
  if (voucher.status === "DRAFT") throw new AppError(409, "VOUCHER_DRAFT", "凭证成本尚未计算完成（DRAFT），请补录采购成本或汇率后重算再确认");
  if (voucher.status === "CONFIRMED") return voucher;
  if (voucher.status !== "ACTIVE") throw new AppError(409, "VOUCHER_NOT_CURRENT", "只有当前有效的凭证可以确认");
  await transitionVoucher(client, voucher.id, "CONFIRMED");
  const confirmed = await client.query<VoucherRow>(`SELECT * FROM material_cost_vouchers WHERE id = $1`, [voucherId]);
  await writeAudit(client, {
    actorUserId,
    action: "COST_VOUCHER_CONFIRM",
    entityType: "MATERIAL_COST_VOUCHER",
    entityId: voucherId,
    afterData: { ...summarizeVoucher(voucher), remark: remark ?? null },
    requestId
  });
  return confirmed.rows[0]!;
}
