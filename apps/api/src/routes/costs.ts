import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  computeProjectCost,
  costAdjustmentInputSchema,
  costSettingsInputSchema,
  exchangeRateInputSchema,
  type ComputedCostLine,
  type CostBatchInput,
  type CostConsumptionInput
} from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { pageMeta, parsePagination } from "../lib/pagination.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";

type Query = Record<string, string | undefined>;
type Queryable = {
  query: <T = any>(text: string, values?: unknown[]) => Promise<{ rows: T[]; rowCount: number | null }>;
};

type RateEntry = { id: string; rate: string; effectiveOn: string };

type ConsumptionRow = {
  id: string;
  batch_id: string;
  used_quantity: string;
  waste_quantity: string;
  stock_unit: string;
  material_id: string;
  material_name: string;
  batch_code: string | null;
  total_cost: string | null;
  currency: string | null;
  received_at: string;
  initial_quantity: string;
};

async function getBaseCurrency(client: Queryable): Promise<string | null> {
  const result = await client.query<{ base_currency: string }>("SELECT base_currency FROM cost_settings");
  return result.rows[0]?.base_currency ?? null;
}

async function loadRateTable(client: Queryable, currencies: string[]): Promise<Map<string, RateEntry[]>> {
  const table = new Map<string, RateEntry[]>();
  if (currencies.length === 0) return table;
  const result = await client.query<{ id: string; currency: string; rate: string; effective_on: string }>(
    `SELECT id, currency, rate_to_base::text AS rate, effective_on::text
       FROM exchange_rates WHERE currency = ANY($1::char(3)[]) ORDER BY currency, effective_on`,
    [currencies]
  );
  for (const row of result.rows) {
    const list = table.get(row.currency) ?? [];
    list.push({ id: row.id, rate: row.rate, effectiveOn: row.effective_on });
    table.set(row.currency, list);
  }
  return table;
}

function makeRateResolver(table: Map<string, RateEntry[]>) {
  return (currency: string, onDate: string): { rate: string; rateId: string | null } | null => {
    const list = table.get(currency);
    if (!list) return null;
    let best: RateEntry | null = null;
    for (const entry of list) {
      if (entry.effectiveOn <= onDate) best = entry;
      else break;
    }
    return best ? { rate: best.rate, rateId: best.id } : null;
  };
}

type ProjectCostInputs = {
  consumptionRows: ConsumptionRow[];
  batches: CostBatchInput[];
  consumptions: CostConsumptionInput[];
  currencies: string[];
};

async function loadProjectCostInputs(client: Queryable, projectId: string, baseCurrency: string): Promise<ProjectCostInputs> {
  const consumptionRows = await client.query<ConsumptionRow>(
    `SELECT c.id, c.batch_id, c.used_quantity::text, c.waste_quantity::text, c.stock_unit::text,
            b.material_id, m.name AS material_name, b.batch_code,
            b.total_cost::text, b.currency, b.received_at::text, b.initial_quantity::text
       FROM consumptions c
       JOIN batches b ON b.id = c.batch_id
       JOIN materials m ON m.id = b.material_id
      WHERE c.project_id = $1 AND c.status = 'ACTIVE'
      ORDER BY c.consumed_at ASC, c.id ASC`,
    [projectId]
  );
  const batchIds = [...new Set(consumptionRows.rows.map((row) => row.batch_id))];
  const adjustmentsByBatch = new Map<string, { amount: string; currency: string; incurredOn: string }[]>();
  const currencies = new Set<string>();
  if (batchIds.length > 0) {
    const adjustments = await client.query<{ batch_id: string; amount: string; currency: string; incurred_on: string }>(
      `SELECT batch_id, amount::text, currency, incurred_on::text
         FROM batch_cost_adjustments WHERE batch_id = ANY($1::uuid[])
         ORDER BY incurred_on, created_at`,
      [batchIds]
    );
    for (const row of adjustments.rows) {
      const list = adjustmentsByBatch.get(row.batch_id) ?? [];
      list.push({ amount: row.amount, currency: row.currency, incurredOn: row.incurred_on });
      adjustmentsByBatch.set(row.batch_id, list);
      if (row.currency !== baseCurrency) currencies.add(row.currency);
    }
  }
  const batches = new Map<string, CostBatchInput>();
  const consumptions: CostConsumptionInput[] = [];
  for (const row of consumptionRows.rows) {
    if (!batches.has(row.batch_id)) {
      if (row.currency && row.currency !== baseCurrency) currencies.add(row.currency);
      batches.set(row.batch_id, {
        batchId: row.batch_id,
        totalCost: row.total_cost,
        currency: row.currency,
        receivedAt: row.received_at,
        initialQuantity: row.initial_quantity,
        adjustments: adjustmentsByBatch.get(row.batch_id) ?? []
      });
    }
    consumptions.push({
      consumptionId: row.id,
      batchId: row.batch_id,
      usedQuantity: row.used_quantity,
      wasteQuantity: row.waste_quantity
    });
  }
  return {
    consumptionRows: consumptionRows.rows,
    batches: [...batches.values()],
    consumptions,
    currencies: [...currencies]
  };
}

/** 成本行的规范化指纹：相同输入必然相同，用于判断重算结果是否发生变化。 */
function linesFingerprint(lines: ComputedCostLine[]): string {
  const canonical = lines
    .map((line) =>
      [
        line.consumptionId,
        line.batchId,
        line.usedQuantity,
        line.wasteQuantity,
        line.currency ?? "",
        line.priced ? "1" : "0",
        line.batchTotalCostBase ?? "",
        line.unitCostBase ?? "",
        line.fxRate ?? "",
        line.usedCostBase ?? "",
        line.wasteCostBase ?? "",
        line.totalCostBase ?? ""
      ].join("|")
    )
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

type CurrentVoucher = {
  id: string;
  voucher_no: string;
  lines_hash: string;
  created_at: string;
};

async function loadCurrentVoucher(client: Queryable, projectId: string): Promise<CurrentVoucher | null> {
  const result = await client.query<CurrentVoucher>(
    `SELECT v.id, v.voucher_no, v.lines_hash, v.created_at
       FROM cost_vouchers v
      WHERE v.project_id = $1
        AND NOT EXISTS (SELECT 1 FROM cost_voucher_supersessions s WHERE s.old_voucher_id = v.id)
      ORDER BY v.created_at DESC
      LIMIT 1`,
    [projectId]
  );
  return result.rows[0] ?? null;
}

function enrichLines(lines: ComputedCostLine[], rows: ConsumptionRow[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return lines.map((line) => {
    const row = byId.get(line.consumptionId);
    return {
      ...line,
      materialId: row?.material_id ?? null,
      materialName: row?.material_name ?? null,
      batchCode: row?.batch_code ?? null,
      stockUnit: row?.stock_unit ?? null
    };
  });
}

export async function costRoutes(app: FastifyInstance): Promise<void> {
  app.get("/settings/cost", async () => {
    const settings = await pool.query<{ base_currency: string; updated_at: string }>(
      `SELECT base_currency, updated_at FROM cost_settings`
    );
    const locked = await pool.query("SELECT 1 FROM cost_vouchers LIMIT 1");
    return {
      data: {
        baseCurrency: settings.rows[0]?.base_currency ?? null,
        locked: (locked.rowCount ?? 0) > 0,
        updatedAt: settings.rows[0]?.updated_at ?? null
      }
    };
  });

  app.put("/settings/cost", async (request) => {
    const input = parseInput(costSettingsInputSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const existing = await client.query<{ id: string; base_currency: string }>("SELECT id, base_currency FROM cost_settings FOR UPDATE");
      const before = existing.rows[0];
      if (before && before.base_currency === input.baseCurrency) {
        const locked = await client.query("SELECT 1 FROM cost_vouchers LIMIT 1");
        return { data: { baseCurrency: before.base_currency, locked: (locked.rowCount ?? 0) > 0, unchanged: true } };
      }
      if (before) {
        const locked = await client.query("SELECT 1 FROM cost_vouchers LIMIT 1");
        if (locked.rowCount) {
          throw new AppError(409, "COST_SETTINGS_LOCKED", "已存在成本凭证，本位币不能再修改；历史凭证的换算结果必须保持可追溯");
        }
      }
      let row: { base_currency: string };
      if (before) {
        const updated = await client.query<{ base_currency: string }>(
          "UPDATE cost_settings SET base_currency = $1 WHERE id = $2 RETURNING base_currency",
          [input.baseCurrency, before.id]
        );
        row = updated.rows[0]!;
      } else {
        const inserted = await client.query<{ base_currency: string }>(
          "INSERT INTO cost_settings(base_currency) VALUES ($1) RETURNING base_currency",
          [input.baseCurrency]
        );
        row = inserted.rows[0]!;
      }
      await writeAudit(client, {
        actorUserId: user.id,
        action: before ? "UPDATE" : "CREATE",
        entityType: "COST_SETTINGS",
        entityId: before?.id ?? null,
        beforeData: before ?? null,
        afterData: { baseCurrency: row.base_currency },
        requestId: request.id
      });
      return { data: { baseCurrency: row.base_currency, locked: false, unchanged: false } };
    });
  });

  app.get<{ Querystring: Query }>("/exchange-rates", async (request) => {
    const { page, pageSize, offset } = parsePagination(request.query);
    const values: unknown[] = [];
    const conditions = ["1 = 1"];
    if (request.query.currency?.trim()) {
      values.push(request.query.currency.trim().toUpperCase());
      conditions.push(`currency = $${values.length}`);
    }
    const where = conditions.join(" AND ");
    const total = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM exchange_rates WHERE ${where}`, values);
    values.push(pageSize, offset);
    const rows = await pool.query(
      `SELECT id, currency, rate_to_base::text AS "rateToBase", effective_on::text AS "effectiveOn",
              notes, created_at AS "createdAt"
         FROM exchange_rates WHERE ${where}
         ORDER BY currency, effective_on DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { data: rows.rows, meta: pageMeta(page, pageSize, Number(total.rows[0]?.count ?? 0)) };
  });

  app.post("/exchange-rates", async (request, reply) => {
    const input = parseInput(exchangeRateInputSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const created = await withTransaction(async (client) => {
      const baseCurrency = await getBaseCurrency(client);
      if (baseCurrency && input.currency === baseCurrency) {
        throw new AppError(422, "REDUNDANT_EXCHANGE_RATE", "本位币汇率恒为 1，无需录入");
      }
      let row;
      try {
        const inserted = await client.query(
          `INSERT INTO exchange_rates(currency, rate_to_base, effective_on, notes, actor_user_id)
           VALUES ($1, $2, $3::date, $4, $5)
           RETURNING id, currency, rate_to_base::text AS "rateToBase", effective_on::text AS "effectiveOn",
                     notes, created_at AS "createdAt"`,
          [input.currency, input.rateToBase, input.effectiveOn, input.notes || null, user.id]
        );
        row = inserted.rows[0];
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new AppError(409, "EXCHANGE_RATE_EXISTS", "该币种在该生效日期已有汇率记录；汇率不可修改，如需修正请按新的生效日期补录");
        }
        throw error;
      }
      await writeAudit(client, {
        actorUserId: user.id,
        action: "CREATE",
        entityType: "EXCHANGE_RATE",
        entityId: row.id,
        afterData: row,
        requestId: request.id
      });
      return row;
    });
    return reply.status(201).send({ data: created });
  });

  app.get<{ Params: { id: string } }>("/batches/:id/cost-adjustments", async (request) => {
    const batch = await pool.query("SELECT id FROM batches WHERE id = $1", [request.params.id]);
    if (!batch.rowCount) throw new AppError(404, "NOT_FOUND", "批次不存在");
    const rows = await pool.query(
      `SELECT id, fee_type AS "feeType", amount::text, currency, incurred_on::text AS "incurredOn",
              notes, created_at AS "createdAt"
         FROM batch_cost_adjustments WHERE batch_id = $1 ORDER BY incurred_on, created_at`,
      [request.params.id]
    );
    return { data: rows.rows };
  });

  app.post<{ Params: { id: string } }>("/batches/:id/cost-adjustments", async (request, reply) => {
    const input = parseInput(costAdjustmentInputSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const created = await withTransaction(async (client) => {
      const batch = await client.query("SELECT id FROM batches WHERE id = $1 FOR SHARE", [request.params.id]);
      if (!batch.rowCount) throw new AppError(404, "NOT_FOUND", "批次不存在");
      const inserted = await client.query(
        `INSERT INTO batch_cost_adjustments(batch_id, fee_type, amount, currency, incurred_on, notes, actor_user_id)
         VALUES ($1, $2, $3, $4, $5::date, $6, $7)
         RETURNING id, fee_type AS "feeType", amount::text, currency, incurred_on::text AS "incurredOn",
                   notes, created_at AS "createdAt"`,
        [request.params.id, input.feeType, input.amount, input.currency, input.incurredOn, input.notes || null, user.id]
      );
      const row = inserted.rows[0];
      await writeAudit(client, {
        actorUserId: user.id,
        action: "CREATE",
        entityType: "BATCH_COST_ADJUSTMENT",
        entityId: row.id,
        afterData: { ...row, batchId: request.params.id },
        requestId: request.id
      });
      return row;
    });
    return reply.status(201).send({ data: created });
  });

  app.get<{ Params: { id: string } }>("/projects/:id/cost-summary", async (request) => {
    const project = await pool.query("SELECT id FROM projects WHERE id = $1", [request.params.id]);
    if (!project.rowCount) throw new AppError(404, "NOT_FOUND", "项目不存在");
    const baseCurrency = await getBaseCurrency(pool);
    if (!baseCurrency) {
      return { data: { configured: false } };
    }
    const inputs = await loadProjectCostInputs(pool, request.params.id, baseCurrency);
    const rateTable = await loadRateTable(pool, inputs.currencies);
    const computation = computeProjectCost(baseCurrency, inputs.batches, inputs.consumptions, makeRateResolver(rateTable));
    const currentVoucher = await loadCurrentVoucher(pool, request.params.id);
    const fingerprint = linesFingerprint(computation.lines);
    return {
      data: {
        configured: true,
        baseCurrency,
        lines: enrichLines(computation.lines, inputs.consumptionRows),
        totals: computation.totals,
        missingRates: computation.missingRates,
        warnings: computation.warnings,
        voucher: currentVoucher
          ? {
              id: currentVoucher.id,
              voucherNo: currentVoucher.voucher_no,
              createdAt: currentVoucher.created_at,
              upToDate: currentVoucher.lines_hash === fingerprint
            }
          : null
      }
    };
  });

  app.post<{ Params: { id: string } }>("/projects/:id/cost-recalculation", async (request) => {
    const user = (request as AuthenticatedRequest).authUser;
    const projectId = request.params.id;
    const result = await withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`cost-recalculation:${projectId}`]);
      const project = await client.query<{ id: string; name: string }>("SELECT id, name FROM projects WHERE id = $1 FOR SHARE", [projectId]);
      if (!project.rowCount) throw new AppError(404, "NOT_FOUND", "项目不存在");
      const baseCurrency = await getBaseCurrency(client);
      if (!baseCurrency) {
        throw new AppError(422, "COST_SETTINGS_MISSING", "请先在设置中配置成本核算本位币");
      }
      const inputs = await loadProjectCostInputs(client, projectId, baseCurrency);
      const rateTable = await loadRateTable(client, inputs.currencies);
      const computation = computeProjectCost(baseCurrency, inputs.batches, inputs.consumptions, makeRateResolver(rateTable));
      if (computation.missingRates.length > 0) {
        const detail = computation.missingRates.map((item) => `${item.currency}（${item.onDate} 前）`).join("、");
        throw new AppError(422, "MISSING_EXCHANGE_RATE", `缺少汇率记录：${detail}。请先补录汇率再重算。`, {
          missingRates: computation.missingRates.map((item) => `${item.currency}@${item.onDate}`)
        });
      }
      const fingerprint = linesFingerprint(computation.lines);
      const currentVoucher = await loadCurrentVoucher(client, projectId);
      if (currentVoucher && currentVoucher.lines_hash === fingerprint) {
        await writeAudit(client, {
          actorUserId: user.id,
          action: "COST_RECALCULATE",
          entityType: "PROJECT",
          entityId: projectId,
          afterData: { voucherNo: currentVoucher.voucher_no, unchanged: true },
          requestId: request.id
        });
        return {
          unchanged: true,
          voucher: { id: currentVoucher.id, voucherNo: currentVoucher.voucher_no, createdAt: currentVoucher.created_at },
          supersedesVoucherNo: null,
          totals: computation.totals
        };
      }
      if (computation.lines.length === 0 && !currentVoucher) {
        return { unchanged: true, voucher: null, supersedesVoucherNo: null, totals: computation.totals };
      }
      const voucher = await client.query<{ id: string; voucher_no: string; created_at: string }>(
        `INSERT INTO cost_vouchers(voucher_no, project_id, base_currency, line_count, priced_line_count,
           used_total, waste_total, grand_total, lines_hash, actor_user_id)
         VALUES ('CV-' || to_char(current_date, 'YYYYMMDD') || '-' || lpad(nextval('cost_voucher_no_seq')::text, 5, '0'),
                 $1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, voucher_no, created_at`,
        [
          projectId,
          baseCurrency,
          computation.lines.length,
          computation.totals.pricedLineCount,
          computation.totals.usedCostBase,
          computation.totals.wasteCostBase,
          computation.totals.totalCostBase,
          fingerprint,
          user.id
        ]
      );
      const voucherRow = voucher.rows[0]!;
      if (computation.lines.length > 0) {
        const rowsByConsumption = new Map(inputs.consumptionRows.map((row) => [row.id, row]));
        const values: unknown[] = [];
        const tuples = computation.lines.map((line, index) => {
          const row = rowsByConsumption.get(line.consumptionId);
          values.push(
            voucherRow.id,
            index + 1,
            line.consumptionId,
            line.batchId,
            row?.material_id ?? null,
            line.usedQuantity,
            line.wasteQuantity,
            row?.stock_unit ?? null,
            line.currency,
            line.priced,
            line.batchTotalCostBase,
            line.unitCostBase,
            line.fxRate,
            line.usedCostBase,
            line.wasteCostBase,
            line.totalCostBase
          );
          const base = values.length - 15;
          return `($${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::stock_unit, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15})`;
        });
        await client.query(
          `INSERT INTO cost_voucher_lines(voucher_id, line_no, consumption_id, batch_id, material_id,
             used_quantity, waste_quantity, stock_unit, currency, priced, batch_total_cost_base,
             unit_cost_base, fx_rate, used_cost_base, waste_cost_base, total_cost_base)
           VALUES ${tuples.join(", ")}`,
          values
        );
      }
      if (currentVoucher) {
        await client.query(
          `INSERT INTO cost_voucher_supersessions(project_id, old_voucher_id, new_voucher_id, reason, actor_user_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [projectId, currentVoucher.id, voucherRow.id, "成本输入变化后重算", user.id]
        );
      }
      await writeAudit(client, {
        actorUserId: user.id,
        action: "COST_RECALCULATE",
        entityType: "PROJECT",
        entityId: projectId,
        afterData: {
          voucherNo: voucherRow.voucher_no,
          unchanged: false,
          supersedesVoucherNo: currentVoucher?.voucher_no ?? null,
          lineCount: computation.lines.length,
          grandTotal: computation.totals.totalCostBase,
          baseCurrency
        },
        requestId: request.id
      });
      return {
        unchanged: false,
        voucher: { id: voucherRow.id, voucherNo: voucherRow.voucher_no, createdAt: voucherRow.created_at },
        supersedesVoucherNo: currentVoucher?.voucher_no ?? null,
        totals: computation.totals
      };
    });
    return { data: result };
  });

  app.get<{ Params: { id: string } }>("/projects/:id/cost-vouchers", async (request) => {
    const project = await pool.query("SELECT id FROM projects WHERE id = $1", [request.params.id]);
    if (!project.rowCount) throw new AppError(404, "NOT_FOUND", "项目不存在");
    const rows = await pool.query(
      `SELECT v.id, v.voucher_no AS "voucherNo", v.base_currency AS "baseCurrency",
              v.line_count AS "lineCount", v.priced_line_count AS "pricedLineCount",
              v.used_total::text AS "usedTotal", v.waste_total::text AS "wasteTotal",
              v.grand_total::text AS "grandTotal", v.created_at AS "createdAt",
              (s.old_voucher_id IS NOT NULL) AS "superseded",
              s.created_at AS "supersededAt", nv.voucher_no AS "supersededByVoucherNo"
         FROM cost_vouchers v
         LEFT JOIN cost_voucher_supersessions s ON s.old_voucher_id = v.id
         LEFT JOIN cost_vouchers nv ON nv.id = s.new_voucher_id
        WHERE v.project_id = $1
        ORDER BY v.created_at DESC`,
      [request.params.id]
    );
    return { data: rows.rows };
  });

  app.get<{ Params: { id: string } }>("/cost-vouchers/:id", async (request) => {
    const voucher = await pool.query(
      `SELECT v.id, v.voucher_no AS "voucherNo", v.project_id AS "projectId", p.name AS "projectName",
              v.base_currency AS "baseCurrency", v.line_count AS "lineCount",
              v.priced_line_count AS "pricedLineCount", v.used_total::text AS "usedTotal",
              v.waste_total::text AS "wasteTotal", v.grand_total::text AS "grandTotal",
              v.lines_hash AS "linesHash", v.created_at AS "createdAt",
              (s.old_voucher_id IS NOT NULL) AS "superseded", nv.voucher_no AS "supersededByVoucherNo",
              (SELECT pv.voucher_no FROM cost_voucher_supersessions ps JOIN cost_vouchers pv ON pv.id = ps.old_voucher_id
                WHERE ps.new_voucher_id = v.id) AS "supersedesVoucherNo"
         FROM cost_vouchers v
         JOIN projects p ON p.id = v.project_id
         LEFT JOIN cost_voucher_supersessions s ON s.old_voucher_id = v.id
         LEFT JOIN cost_vouchers nv ON nv.id = s.new_voucher_id
        WHERE v.id = $1`,
      [request.params.id]
    );
    if (!voucher.rows[0]) throw new AppError(404, "NOT_FOUND", "成本凭证不存在");
    const lines = await pool.query(
      `SELECT l.line_no AS "lineNo", l.consumption_id AS "consumptionId", l.batch_id AS "batchId",
              b.batch_code AS "batchCode", m.name AS "materialName",
              l.used_quantity::text AS "usedQuantity", l.waste_quantity::text AS "wasteQuantity",
              l.stock_unit AS "stockUnit", l.currency, l.priced,
              l.batch_total_cost_base::text AS "batchTotalCostBase",
              l.unit_cost_base::text AS "unitCostBase", l.fx_rate::text AS "fxRate",
              l.used_cost_base::text AS "usedCostBase", l.waste_cost_base::text AS "wasteCostBase",
              l.total_cost_base::text AS "totalCostBase"
         FROM cost_voucher_lines l
         JOIN batches b ON b.id = l.batch_id
         JOIN materials m ON m.id = l.material_id
        WHERE l.voucher_id = $1 ORDER BY l.line_no`,
      [request.params.id]
    );
    return { data: { ...voucher.rows[0], lines: lines.rows } };
  });
}
