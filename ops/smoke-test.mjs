const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8080";
const configuredPassword = process.env.SMOKE_PASSWORD;
if (!configuredPassword) {
  throw new Error("SMOKE_PASSWORD is required");
}
let cookie = "";

async function callWithStatus(path, options = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set("cookie", cookie);
  if (options.body !== undefined && !(options.body instanceof FormData)) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    ...options,
    headers,
    body: options.body instanceof FormData ? options.body : options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} -> ${response.status} ${JSON.stringify(payload)}`);
  }
  return { status: response.status, data: payload };
}

async function call(path, options = {}) {
  return (await callWithStatus(path, options)).data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const status = await call("/setup/status");
if (!status.data.initialized) {
  await call("/setup", { method: "POST", body: { displayName: "Smoke Test Operator", password: configuredPassword } });
  console.log("Initialized a new empty workspace.");
} else {
  await call("/auth/login", { method: "POST", body: { password: configuredPassword } });
}

const suffix = Date.now().toString(36);
const source = await call("/sources", { method: "POST", body: { name: `Smoke Source ${suffix}`, type: "PURCHASED" } });
const material = await call("/materials", {
  method: "POST",
  body: {
    code: `SMOKE-${suffix}`,
    name: `Smoke Material ${suffix}`,
    craftTypes: ["GENERAL"],
    stockUnit: "g",
    lowStockThreshold: "100",
    defaultColorName: "Original",
    defaultColorHex: "#8B5A2B",
    tags: ["smoke"]
  }
});
const batchPayload = {
  materialId: material.data.id,
  batchCode: `B-${suffix}`,
  sourceId: source.data.id,
  receivedAt: new Date().toISOString().slice(0, 10),
  initialQuantity: "1",
  entryUnit: "kg"
};
const [batchResult, repeatedBatchResult] = await Promise.all([
  callWithStatus("/batches", {
    method: "POST",
    headers: { "idempotency-key": `smoke-batch-${suffix}` },
    body: batchPayload
  }),
  callWithStatus("/batches", {
    method: "POST",
    headers: { "idempotency-key": `smoke-batch-${suffix}` },
    body: batchPayload
  })
]);
assert([200, 201].includes(batchResult.status) && [200, 201].includes(repeatedBatchResult.status), "Concurrent batch idempotency returned an unexpected status");
const batch = batchResult.status === 201 ? batchResult.data.data : repeatedBatchResult.data.data;
const repeatedBatch = batchResult.status === 201 ? repeatedBatchResult.data.data : batchResult.data.data;
assert(repeatedBatch.id === batch.id, "Batch idempotency returned a different batch");
const project = await call("/projects", {
  method: "POST",
  body: { name: `Smoke Project ${suffix}`, craftType: "GENERAL", status: "PLANNED" }
});
const requirement = await call(`/projects/${project.data.id}/requirements`, {
  method: "POST",
  body: { materialId: material.data.id, requiredQuantity: "500", unit: "g", purpose: "Smoke verification" }
});
const consumptionPayload = {
  projectId: project.data.id,
  projectRequirementId: requirement.data.id,
  batchId: batch.id,
  usedQuantity: "450",
  wasteQuantity: "50",
  unit: "g",
  purpose: "Smoke verification"
};
const [consumptionResult, repeatedConsumptionResult] = await Promise.all([
  callWithStatus("/consumptions", {
    method: "POST",
    headers: { "idempotency-key": `smoke-consumption-${suffix}` },
    body: consumptionPayload
  }),
  callWithStatus("/consumptions", {
    method: "POST",
    headers: { "idempotency-key": `smoke-consumption-${suffix}` },
    body: consumptionPayload
  })
]);
assert([200, 201].includes(consumptionResult.status) && [200, 201].includes(repeatedConsumptionResult.status), "Concurrent consumption idempotency returned an unexpected status");
const consumption = consumptionResult.status === 201 ? consumptionResult.data.data : repeatedConsumptionResult.data.data;
const repeatedConsumption = consumptionResult.status === 201 ? repeatedConsumptionResult.data.data : consumptionResult.data.data;
assert(repeatedConsumption.id === consumption.id, "Consumption idempotency returned a different row");
assert(consumption.totalQuantity === "500.000000", "Consumption total is incorrect");

const latestOccurredAt = new Date();
await call("/color-changes", {
  method: "POST",
  body: {
    batchId: batch.id,
    projectId: project.data.id,
    changeType: "OTHER",
    afterColorName: "Smoke Brown",
    afterColorHex: "#6B2F1F",
    affectedQuantity: "450",
    unit: "g",
    occurredAt: latestOccurredAt.toISOString()
  }
});
const backdatedColor = await call("/color-changes", {
  method: "POST",
  body: {
    batchId: batch.id,
    projectId: project.data.id,
    changeType: "OTHER",
    afterColorName: "Backdated Blue",
    afterColorHex: "#0000FF",
    occurredAt: new Date(latestOccurredAt.getTime() - 60_000).toISOString()
  }
});
assert(backdatedColor.data.isCurrent === false, "Backdated color was treated as current");

const afterConsumption = await call(`/batches/${batch.id}`);
assert(afterConsumption.data.remainingQuantity === "500.000000", "Batch balance after consumption is incorrect");
assert(afterConsumption.data.currentColorName === "Smoke Brown", "Current color was not updated");
const projectAfterConsumption = await call(`/projects/${project.data.id}`);
assert(projectAfterConsumption.data.requirements[0].actualQuantity === "500.000000", "Project actual quantity is incorrect");
assert(projectAfterConsumption.data.status === "IN_PROGRESS", "First consumption did not start the planned project");

await call(`/consumptions/${consumption.id}/reverse`, { method: "POST", body: { reason: "Automated smoke test reversal" } });
const afterReversal = await call(`/batches/${batch.id}`);
assert(afterReversal.data.remainingQuantity === "1000.000000", "Batch balance after reversal is incorrect");
assert(afterReversal.data.movements[0].type === "REVERSAL", "Reversal movement was not created");
const reversedVouchers = await call(`/costing/vouchers?consumptionId=${consumption.id}&current=true`);
const netCost = reversedVouchers.data.reduce((sum, v) => sum + Number(v.totalCostBase), 0);
assert(netCost === 0, "Consumption and reversal current vouchers must net to zero");

const search = await call(`/materials?${new URLSearchParams({ q: `Smoke Material ${suffix}`, craftType: "GENERAL", color: "Smoke Brown", stockState: "in_stock" })}`);
assert(search.meta.total >= 1, "Material search did not find the smoke-test material");

// ---- 项目用料成本核算验收 ----
const settings = await call("/costing/settings");
assert(settings.data.baseCurrency.length === 3, "Costing base currency missing");
const foreignBatch = await call("/batches", {
  method: "POST",
  body: {
    materialId: material.data.id,
    batchCode: `B-FX-${suffix}`,
    receivedAt: new Date().toISOString().slice(0, 10),
    initialQuantity: "1000",
    entryUnit: "g",
    totalCost: "10.00",
    currency: "USD"
  }
});
const fxConsumption = await call("/consumptions", {
  method: "POST",
  body: { projectId: project.data.id, batchId: foreignBatch.data.id, usedQuantity: "450", wasteQuantity: "50", unit: "g" }
});
// 尚无 USD 汇率：凭证应为 DRAFT
let vouchers = await call(`/costing/vouchers?consumptionId=${fxConsumption.data.id}&current=true`);
let draft = vouchers.data.find((v) => v.eventType === "CONSUMPTION");
assert(draft && draft.status === "DRAFT", "Foreign-currency voucher without rate should be DRAFT");

// 登记汇率后自动重算为 ACTIVE
const rate = await call("/costing/rates", {
  method: "POST",
  body: { currency: "USD", rateToBase: "7.1823", effectiveFrom: new Date().toISOString().slice(0, 10), note: "smoke" }
});
assert(rate.data.recompute && rate.data.recompute.created >= 1, "Rate backfill should trigger voucher recomputation");
vouchers = await call(`/costing/vouchers?consumptionId=${fxConsumption.data.id}&current=true`);
const active = vouchers.data.find((v) => v.eventType === "CONSUMPTION");
assert(active.status === "ACTIVE" && Number(active.totalCostBase) > 0, "Voucher should become ACTIVE with base-currency amount");
// 450/50 分摊：使用与损耗之和严格等于总额
assert((Number(active.usedCostBase) + Number(active.wasteCostBase)).toFixed(2) === active.totalCostBase, "Used + waste must equal total");

// 幂等重算：同样输入不应产生新版本
const recomputeAgain = await call("/costing/recompute", { method: "POST", body: { batchId: foreignBatch.data.id } });
assert(recomputeAgain.data.created === 0 && recomputeAgain.data.unchanged >= 1, "Repeated recomputation must be stable (no new versions)");

// 批次成本补录（追加），自动产生新版本
const adjustment = await call(`/batches/${foreignBatch.data.id}/costs`, {
  method: "POST",
  body: { amount: "5.00", currency: "USD", effectiveFrom: new Date().toISOString().slice(0, 10), reason: "Smoke freight backfill" }
});
assert(adjustment.data.recompute.created >= 1, "Cost backfill should create a new voucher version");

// 补录后取最新当前版本并确认结转
vouchers = await call(`/costing/vouchers?consumptionId=${fxConsumption.data.id}&current=true`);
const currentVoucher = vouchers.data.find((v) => v.eventType === "CONSUMPTION");
assert(currentVoucher.status === "ACTIVE", "Current voucher should be ACTIVE before confirmation");
await call(`/costing/vouchers/${currentVoucher.id}/confirm`, { method: "POST", body: {} });
const afterConfirm = await call("/costing/vouchers?consumptionId=" + fxConsumption.data.id);
const confirmedVersion = afterConfirm.data.find((v) => v.status === "CONFIRMED");
assert(Boolean(confirmedVersion), "Voucher should be CONFIRMED");
const skipped = await call("/costing/recompute", { method: "POST", body: { batchId: foreignBatch.data.id } });
assert(skipped.data.skipped >= 1, "CONFIRMED vouchers must be skipped by auto recomputation");

// 历史版本链完整可查
const detail = await call(`/costing/vouchers/${confirmedVersion.id}`);
assert(detail.data.chain.length >= 3, "Version chain should preserve DRAFT and superseded versions");
assert(detail.data.chain.every((v) => ["DRAFT", "ACTIVE", "CONFIRMED", "SUPERSEDED"].includes(v.status)), "Unexpected voucher status in chain");

// 已确认凭证不能直接改回有效（只追加，历史不可静默改写）
const confirmRejected = await callWithStatus(`/costing/vouchers/${confirmedVersion.id}/confirm`, { method: "POST", body: {} });
assert(confirmRejected.status === 200, "Re-confirming an already confirmed voucher should be a no-op success");

// 项目成本汇总取当前版本净额
const costing = await call(`/projects/${project.data.id}/costing`);
assert(costing.data.baseCurrency === settings.data.baseCurrency, "Project costing summary missing");

console.log(JSON.stringify({
  result: "PASS",
  sourceId: source.data.id,
  materialId: material.data.id,
  batchId: batch.id,
  projectId: project.data.id,
  consumptionId: consumption.id,
  costVoucherChainLength: detail.data.chain.length,
  projectTotalCostBase: costing.data.summary.total_base
}, null, 2));
