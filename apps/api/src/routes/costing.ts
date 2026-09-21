import type { FastifyInstance } from "fastify";
import {
  confirmVoucherSchema,
  costAdjustmentInputSchema,
  currencyRateInputSchema,
  costingSettingsSchema,
  recomputeScopeSchema,
  reopenVoucherSchema
} from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { pageMeta, parsePagination } from "../lib/pagination.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";
import { confirmVoucher, getBaseCurrency, recomputeVouchers, refreshVoucherChain, remainingBeforeConsumption } from "../lib/costingService.js";

type Query = Record<string, string | undefined>;

function mergeRecompute(
  left: { created: number; unchanged: number; skipped: number; drafts: number; reopened: number; voucherIds: string[] } | null,
  right: { created: number; unchanged: number; skipped: number; drafts: number; reopened: number; voucherIds: string[] }
) {
  if (!left) return right;
  return {
    created: left.created + right.created,
    unchanged: left.unchanged + right.unchanged,
    skipped: left.skipped + right.skipped,
    drafts: left.drafts + right.drafts,
    reopened: left.reopened + right.reopened,
    voucherIds: [...left.voucherIds, ...right.voucherIds]
  };
}

const voucherSelect = `
  v.id, v.root_voucher_id AS "rootVoucherId", v.supersedes_voucher_id AS "supersedesVoucherId",
  v.version, v.event_type AS "eventType", v.consumption_id AS "consumptionId", v.project_id AS "projectId",
  v.batch_id AS "batchId", v.status, v.used_quantity::text AS "usedQuantity",
  v.waste_quantity::text AS "wasteQuantity", v.total_quantity::text AS "totalQuantity",
  v.batch_initial_quantity::text AS "batchInitialQuantity",
  v.batch_remaining_before::text AS "batchRemainingBefore",
  v.unit_cost_orig::text AS "unitCostOrig", v.used_cost_orig::text AS "usedCostOrig",
  v.waste_cost_orig::text AS "wasteCostOrig", v.total_cost_orig::text AS "totalCostOrig",
  v.currency, v.exchange_rate::text AS "exchangeRate", v.exchange_rate_date AS "exchangeRateDate",
  v.unit_cost_base::text AS "unitCostBase", v.used_cost_base::text AS "usedCostBase",
  v.waste_cost_base::text AS "wasteCostBase", v.total_cost_base::text AS "totalCostBase",
  v.base_currency AS "baseCurrency", v.basis, v.remark, v.confirmed_at AS "confirmedAt",
  v.created_at AS "createdAt", u.display_name AS "createdByName",
  p.name AS "projectName", m.name AS "materialName", b.batch_code AS "batchCode"`;

export async function costingRoutes(app: FastifyInstance): Promise<void> {
  // ---------- 核算设置（基准币种） ----------
  app.get("/costing/settings", async () => {
    const result = await pool.query<{ base_currency: string; updated_at: string }>(
      "SELECT base_currency, updated_at FROM costing_settings WHERE id = true"
    );
    return { data: { baseCurrency: result.rows[0]?.base_currency ?? "CNY", updatedAt: result.rows[0]?.updated_at ?? null } };
  });

  app.put("/costing/settings", async (request) => {
    const input = parseInput(costingSettingsSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const before = await client.query("SELECT * FROM costing_settings WHERE id = true FOR UPDATE");
      const result = await client.query(
        "UPDATE costing_settings SET base_currency = $1 WHERE id = true RETURNING base_currency AS \"baseCurrency\", updated_at AS \"updatedAt\"",
        [input.baseCurrency]
      );
      await writeAudit(client, {
        actorUserId: user.id, action: "UPDATE", entityType: "COSTING_SETTINGS",
        beforeData: before.rows[0], afterData: result.rows[0], requestId: request.id
      });
      return { data: result.rows[0] };
    });
  });

  // ---------- 汇率（按生效日期版本化，不覆盖历史） ----------
  app.get<{ Querystring: Query }>("/costing/rates", async (request) => {
    const { page, pageSize, offset } = parsePagination(request.query);
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (request.query.currency) {
      values.push(request.query.currency.toUpperCase());
      conditions.push(`currency = $${values.length}`);
    }
    if (request.query.asOf) {
      values.push(request.query.asOf);
      conditions.push(`effective_from <= $${values.length}::date`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM currency_rates ${where}`, values);
    values.push(pageSize, offset);
    const rows = await pool.query(
      `SELECT r.id, r.currency, r.rate_to_base::text AS "rateToBase", r.effective_from AS "effectiveFrom",
              r.note, r.created_at AS "createdAt", u.display_name AS "createdByName"
         FROM currency_rates r JOIN users u ON u.id = r.actor_user_id
         ${where}
        ORDER BY r.currency, r.effective_from DESC, r.created_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    const settings = await pool.query<{ base_currency: string }>("SELECT base_currency FROM costing_settings WHERE id = true");
    return {
      data: rows.rows,
      meta: pageMeta(page, pageSize, Number(total.rows[0]?.count ?? 0)),
      baseCurrency: settings.rows[0]?.base_currency ?? "CNY"
    };
  });

  app.post("/costing/rates", async (request, reply) => {
    const input = parseInput(currencyRateInputSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const created = await withTransaction(async (client) => {
      const baseCurrency = await getBaseCurrency(client);
      if (input.currency === baseCurrency) {
        throw new AppError(422, "RATE_IS_BASE_CURRENCY", `基准币种 ${baseCurrency} 不需要维护汇率`);
      }
      const duplicate = await client.query(
        "SELECT id FROM currency_rates WHERE currency = $1 AND effective_from = $2::date",
        [input.currency, input.effectiveFrom]
      );
      if (duplicate.rowCount) {
        throw new AppError(409, "RATE_VERSION_EXISTS", `${input.currency} 在 ${input.effectiveFrom} 已存在汇率版本，请改用其他生效日期`);
      }
      const result = await client.query(
        `INSERT INTO currency_rates(currency, rate_to_base, effective_from, note, actor_user_id)
         VALUES ($1, $2, $3::date, $4, $5)
         RETURNING id, currency, rate_to_base::text AS "rateToBase", effective_from AS "effectiveFrom",
                   note, created_at AS "createdAt"`,
        [input.currency, input.rateToBase, input.effectiveFrom, input.note || null, user.id]
      );
      await writeAudit(client, {
        actorUserId: user.id, action: "CREATE", entityType: "CURRENCY_RATE",
        entityId: result.rows[0]?.id, afterData: result.rows[0], requestId: request.id
      });
      // 汇率补录后自动重算使用该币种（批次原币或补录成本币种）的可变更凭证；
      // CONFIRMED 凭证不受影响。
      const affectedBatches = await client.query<{ id: string }>(
        `SELECT DISTINCT b.id FROM batches b
          WHERE b.currency = $1
            OR EXISTS (
              SELECT 1 FROM batch_cost_adjustments a WHERE a.batch_id = b.id AND a.currency = $1
            )`,
        [input.currency]
      );
      let recompute = null;
      if (affectedBatches.rows[0]) {
        recompute = await recomputeVouchers(
          client,
          { batchId: affectedBatches.rows[0].id },
          { actorUserId: user.id, requestId: request.id }
        );
      }
      if (affectedBatches.rows.length > 1) {
        for (const row of affectedBatches.rows.slice(1)) {
          const part = await recomputeVouchers(
            client,
            { batchId: row.id },
            { actorUserId: user.id, requestId: request.id }
          );
          recompute = mergeRecompute(recompute, part);
        }
      }
      return { ...result.rows[0], recompute };
    });
    return reply.status(201).send({ data: created });
  });

  // ---------- 批次采购成本补录（追加，不改写入库成本） ----------
  app.get<{ Params: { id: string } }>("/batches/:id/costs", async (request) => {
    const header = await pool.query<{
      total_cost: string | null; currency: string | null; initial_quantity: string; remaining_quantity: string;
    }>(
      `SELECT total_cost::text AS total_cost, currency, initial_quantity::text AS initial_quantity,
              remaining_quantity::text AS remaining_quantity FROM batches WHERE id = $1`,
      [request.params.id]
    );
    if (!header.rows[0]) throw new AppError(404, "NOT_FOUND", "批次不存在");
    const adjustments = await pool.query(
      `SELECT a.id, a.amount::text AS amount, a.currency, a.effective_from AS "effectiveFrom",
              a.remaining_quantity_at_entry::text AS "remainingQuantityAtEntry", a.reason,
              a.created_at AS "createdAt", u.display_name AS "createdByName"
         FROM batch_cost_adjustments a JOIN users u ON u.id = a.actor_user_id
        WHERE a.batch_id = $1 ORDER BY a.effective_from, a.created_at`,
      [request.params.id]
    );
    return {
      data: {
        batchId: request.params.id,
        openingCost: header.rows[0]?.total_cost ?? null,
        openingCurrency: header.rows[0]?.currency ?? null,
        initialQuantity: header.rows[0]?.initial_quantity ?? null,
        remainingQuantity: header.rows[0]?.remaining_quantity ?? null,
        adjustments: adjustments.rows
      }
    };
  });

  app.post<{ Params: { id: string } }>("/batches/:id/costs", async (request, reply) => {
    const input = parseInput(costAdjustmentInputSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const created = await withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('costing:batch:' || $1, 0))", [request.params.id]);
      const batch = await client.query<{
        remaining_quantity: string; status: string; received_at: string; currency: string | null;
      }>(
        "SELECT remaining_quantity::text AS remaining_quantity, status, received_at::text AS received_at, currency FROM batches WHERE id = $1 FOR UPDATE",
        [request.params.id]
      );
      if (!batch.rows[0]) throw new AppError(404, "NOT_FOUND", "批次不存在");
      if (batch.rows[0].status === "ARCHIVED") throw new AppError(409, "BATCH_ARCHIVED", "已归档批次不能补录成本");
      if (input.effectiveFrom < batch.rows[0].received_at) {
        throw new AppError(422, "INVALID_EFFECTIVE_DATE", "成本生效日期不能早于批次入库日期");
      }
      const result = await client.query(
        `INSERT INTO batch_cost_adjustments(batch_id, remaining_quantity_at_entry, amount, currency, effective_from, reason, actor_user_id)
         VALUES ($1, $2, $3, $4, $5::date, $6, $7)
         RETURNING id, amount::text AS amount, currency, effective_from AS "effectiveFrom",
                   remaining_quantity_at_entry::text AS "remainingQuantityAtEntry", reason, created_at AS "createdAt"`,
        [request.params.id, batch.rows[0].remaining_quantity, input.amount, input.currency, input.effectiveFrom, input.reason, user.id]
      );
      await writeAudit(client, {
        actorUserId: user.id, action: "COST_ADJUSTMENT_CREATE", entityType: "BATCH_COST_ADJUSTMENT",
        entityId: result.rows[0]?.id, afterData: { batchId: request.params.id, ...result.rows[0] }, requestId: request.id
      });
      // 补录后自动重算该批次所有可变更凭证；CONFIRMED 跳过。
      const recompute = await recomputeVouchers(
        client,
        { batchId: request.params.id },
        { actorUserId: user.id, requestId: request.id }
      );
      return { ...result.rows[0], recompute };
    });
    return reply.status(201).send({ data: created });
  });

  // 手工触发批次/项目重算（汇率或成本批量补录后的兜底入口）。
  app.post("/costing/recompute", async (request) => {
    const body = parseInput(recomputeScopeSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const summary = await recomputeVouchers(
        client,
        { batchId: body.batchId, projectId: body.projectId },
        { actorUserId: user.id, requestId: request.id }
      );
      return { data: summary };
    });
  });

  // ---------- 成本凭证 ----------
  app.get<{ Querystring: Query }>("/costing/vouchers", async (request) => {
    const { page, pageSize, offset } = parsePagination(request.query);
    const values: unknown[] = [];
    const conditions: string[] = [];
    for (const [key, column] of [
      ["projectId", "v.project_id"], ["batchId", "v.batch_id"], ["consumptionId", "v.consumption_id"],
      ["status", "v.status"], ["eventType", "v.event_type"]
    ] as const) {
      if (request.query[key]) {
        values.push(request.query[key]);
        const cast = key === "status" ? "::cost_voucher_status" : key === "eventType" ? "::varchar" : "::uuid";
        conditions.push(`${column} = $${values.length}${cast}`);
      }
    }
    if (request.query.currency) {
      values.push(request.query.currency.toUpperCase());
      conditions.push(`v.currency = $${values.length}`);
    }
    if (request.query.current === "true") {
      conditions.push("v.status IN ('DRAFT', 'ACTIVE', 'CONFIRMED')");
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM material_cost_vouchers v ${where}`, values);
    values.push(pageSize, offset);
    const rows = await pool.query(
      `SELECT ${voucherSelect}
         FROM material_cost_vouchers v
         JOIN users u ON u.id = v.created_by
         JOIN projects p ON p.id = v.project_id
         JOIN batches b ON b.id = v.batch_id
         JOIN materials m ON m.id = b.material_id
         ${where}
        ORDER BY v.created_at DESC, v.version DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { data: rows.rows, meta: pageMeta(page, pageSize, Number(total.rows[0]?.count ?? 0)) };
  });

  app.get<{ Params: { id: string } }>("/costing/vouchers/:id", async (request) => {
    const result = await pool.query(
      `SELECT ${voucherSelect}
         FROM material_cost_vouchers v
         JOIN users u ON u.id = v.created_by
         JOIN projects p ON p.id = v.project_id
         JOIN batches b ON b.id = v.batch_id
         JOIN materials m ON m.id = b.material_id
        WHERE v.id = $1`,
      [request.params.id]
    );
    if (!result.rows[0]) throw new AppError(404, "NOT_FOUND", "成本凭证不存在");
    const history = await pool.query(
      `SELECT id, version, status, event_type AS "eventType", total_cost_base AS "totalCostBase",
              total_cost_orig AS "totalCostOrig", currency, exchange_rate AS "exchangeRate",
              supersedes_voucher_id AS "supersedesVoucherId", created_at AS "createdAt", confirmed_at AS "confirmedAt"
         FROM material_cost_vouchers
        WHERE root_voucher_id = (SELECT root_voucher_id FROM material_cost_vouchers WHERE id = $1)
        ORDER BY version, created_at`,
      [request.params.id]
    );
    return { data: { ...result.rows[0], chain: history.rows } };
  });

  app.post<{ Params: { id: string } }>("/costing/vouchers/:id/confirm", async (request) => {
    const input = parseInput(confirmVoucherSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const voucher = await confirmVoucher(client, request.params.id, user.id, request.id, input.remark ?? null);
      return { data: voucher };
    });
  });

  // 显式重开已确认凭证：产生新版本，旧 CONFIRMED 凭证原样保留为 SUPERSEDED（可审计，不静默改写）。
  app.post<{ Params: { id: string } }>("/costing/vouchers/:id/reopen", async (request) => {
    const input = parseInput(reopenVoucherSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const voucherResult = await client.query<{
        id: string; consumption_id: string; status: string;
      }>("SELECT id, consumption_id, status FROM material_cost_vouchers WHERE id = $1 FOR UPDATE", [request.params.id]);
      const voucher = voucherResult.rows[0];
      if (!voucher) throw new AppError(404, "NOT_FOUND", "成本凭证不存在");
      if (voucher.status !== "CONFIRMED") throw new AppError(409, "VOUCHER_NOT_CONFIRMED", "只有已确认的凭证需要重开");
      const consumption = await client.query<{
        id: string; project_id: string; batch_id: string;
        used_quantity: string; waste_quantity: string; total_quantity: string; consumed_at: string;
        initial_quantity: string; total_cost: string | null; currency: string | null;
      }>(
        `SELECT c.id, c.project_id, c.batch_id, c.used_quantity::text AS used_quantity,
                c.waste_quantity::text AS waste_quantity, c.total_quantity::text AS total_quantity,
                c.consumed_at::text AS consumed_at, b.initial_quantity::text AS initial_quantity,
                b.total_cost::text AS total_cost, b.currency
           FROM consumptions c JOIN batches b ON b.id = c.batch_id WHERE c.id = $1`,
        [voucher.consumption_id]
      );
      const row = consumption.rows[0]!;
      const before = await remainingBeforeConsumption(client, row.id);
      const result = await refreshVoucherChain(client, {
        consumption: {
          id: row.id, projectId: row.project_id, batchId: row.batch_id,
          usedQuantity: row.used_quantity, wasteQuantity: row.waste_quantity, totalQuantity: row.total_quantity
        },
        valueDate: row.consumed_at.slice(0, 10),
        batchInfo: { initialQuantity: row.initial_quantity, remainingBefore: before, totalCost: row.total_cost, currency: row.currency },
        actorUserId: user.id,
        requestId: request.id,
        action: "REOPEN",
        reopen: { currentId: voucher.id, reason: input.reason },
        remark: input.reason
      });
      return { data: { voucher: result.voucher, reversalVoucher: result.reversalVoucher } };
    });
  });

  // ---------- 项目成本汇总 ----------
  app.get<{ Params: { id: string } }>("/projects/:id/costing", async (request) => {
    const project = await pool.query("SELECT id, name FROM projects WHERE id = $1", [request.params.id]);
    if (!project.rows[0]) throw new AppError(404, "NOT_FOUND", "项目不存在");
    const [settings, summary, byMaterial, vouchers] = await Promise.all([
      pool.query<{ base_currency: string }>("SELECT base_currency FROM costing_settings WHERE id = true"),
      pool.query<{
        used_base: string; waste_base: string; total_base: string; draft_count: string; confirmed_count: string; active_count: string;
      }>(
        // 只统计当前版本（DRAFT/ACTIVE/CONFIRMED）；红冲链金额为负，天然抵消已撤销消耗。
        `WITH current_vouchers AS (
           SELECT * FROM material_cost_vouchers
             WHERE project_id = $1 AND status IN ('DRAFT','ACTIVE','CONFIRMED')
         )
         SELECT coalesce(sum(used_cost_base), 0)::text AS used_base,
                coalesce(sum(waste_cost_base), 0)::text AS waste_base,
                coalesce(sum(total_cost_base) FILTER (WHERE status IN ('ACTIVE','CONFIRMED')), 0)::text AS total_base,
                count(*) FILTER (WHERE status = 'DRAFT')::text AS draft_count,
                count(*) FILTER (WHERE status = 'CONFIRMED')::text AS confirmed_count,
                count(*) FILTER (WHERE status = 'ACTIVE')::text AS active_count
           FROM current_vouchers`,
        [request.params.id]
      ),
      pool.query(
        `SELECT m.id AS "materialId", m.name AS "materialName",
                coalesce(sum(v.used_cost_base) FILTER (WHERE v.status IN ('ACTIVE','CONFIRMED')), 0)::text AS "usedCostBase",
                coalesce(sum(v.waste_cost_base) FILTER (WHERE v.status IN ('ACTIVE','CONFIRMED')), 0)::text AS "wasteCostBase",
                coalesce(sum(v.total_cost_base) FILTER (WHERE v.status IN ('ACTIVE','CONFIRMED')), 0)::text AS "totalCostBase",
                coalesce(sum(v.used_quantity) FILTER (WHERE v.status IN ('ACTIVE','CONFIRMED') AND v.event_type = 'CONSUMPTION'), 0)::text AS "usedQuantity",
                coalesce(sum(v.waste_quantity) FILTER (WHERE v.status IN ('ACTIVE','CONFIRMED') AND v.event_type = 'CONSUMPTION'), 0)::text AS "wasteQuantity"
           FROM material_cost_vouchers v JOIN batches b ON b.id = v.batch_id JOIN materials m ON m.id = b.material_id
          WHERE v.project_id = $1 AND v.status IN ('DRAFT','ACTIVE','CONFIRMED')
          GROUP BY m.id, m.name ORDER BY m.name`,
        [request.params.id]
      ),
      pool.query(
        `SELECT ${voucherSelect} FROM material_cost_vouchers v
           JOIN users u ON u.id = v.created_by
           JOIN projects p ON p.id = v.project_id
           JOIN batches b ON b.id = v.batch_id
           JOIN materials m ON m.id = b.material_id
          WHERE v.project_id = $1 AND v.status IN ('DRAFT','ACTIVE','CONFIRMED')
          ORDER BY v.created_at DESC`,
        [request.params.id]
      )
    ]);
    return {
      data: {
        projectId: request.params.id,
        baseCurrency: settings.rows[0]?.base_currency ?? "CNY",
        summary: summary.rows[0],
        byMaterial: byMaterial.rows,
        vouchers: vouchers.rows
      }
    };
  });
}
