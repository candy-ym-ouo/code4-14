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
  entryUnit: "kg",
  totalCost: "200.00",
  currency: "USD"
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

// ---- 成本核算验收：分摊、重算稳定、凭证不可变 ----
const today = new Date();
const todayStr = today.toISOString().slice(0, 10);
const yesterdayStr = new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10);
const fmtCents = (cents) => (cents / 100).toFixed(2);
const expectedLineCents = (rate, quantity) => Math.round(Math.round(20000 * rate + 3500 - 500) * quantity / 1000);

const costSettings = await call("/settings/cost");
if (!costSettings.data.baseCurrency) {
  await call("/settings/cost", { method: "PUT", body: { baseCurrency: "CNY" } });
}
assert((await call("/settings/cost")).data.baseCurrency === "CNY", "Base currency is not CNY");

const existingUsdRates = await call("/exchange-rates?currency=USD&pageSize=100");
if (!existingUsdRates.data.some((rate) => rate.effectiveOn === yesterdayStr)) {
  await call("/exchange-rates", { method: "POST", body: { currency: "USD", rateToBase: "7", effectiveOn: yesterdayStr, notes: "smoke base rate" } });
}

await call(`/batches/${batch.id}/cost-adjustments`, { method: "POST", body: { feeType: "运费", amount: "35.00", currency: "CNY", incurredOn: todayStr } });
await call(`/batches/${batch.id}/cost-adjustments`, { method: "POST", body: { feeType: "折让", amount: "-5.00", currency: "CNY", incurredOn: todayStr } });
const adjustments = await call(`/batches/${batch.id}/cost-adjustments`);
assert(adjustments.data.length === 2, "Batch cost adjustments were not recorded");

const costConsumption = await call("/consumptions", {
  method: "POST",
  body: { projectId: project.data.id, batchId: batch.id, usedQuantity: "90", wasteQuantity: "10", unit: "g", purpose: "Cost verification" }
});

const summary = await call(`/projects/${project.data.id}/cost-summary`);
assert(summary.data.configured === true, "Cost summary is not configured");
const summaryLine = summary.data.lines.find((line) => line.consumptionId === costConsumption.data.id);
assert(summaryLine && summaryLine.priced, "Cost summary line is not priced");
const appliedRate = Number(summaryLine.fxRate);
assert(summaryLine.usedCostBase === fmtCents(expectedLineCents(appliedRate, 90)), "Used cost allocation is incorrect");
assert(summaryLine.wasteCostBase === fmtCents(expectedLineCents(appliedRate, 10)), "Waste cost allocation is incorrect");
assert(summary.data.totals.totalCostBase === fmtCents(expectedLineCents(appliedRate, 90) + expectedLineCents(appliedRate, 10)), "Cost totals are incorrect");

const firstRecalc = await call(`/projects/${project.data.id}/cost-recalculation`, { method: "POST" });
assert(firstRecalc.data.unchanged === false && firstRecalc.data.voucher, "First recalculation did not post a voucher");
const firstVoucherNo = firstRecalc.data.voucher.voucherNo;
const repeatRecalc = await call(`/projects/${project.data.id}/cost-recalculation`, { method: "POST" });
assert(repeatRecalc.data.unchanged === true, "Recalculation with unchanged inputs was not stable");

// 汇率补录后重算：生成新凭证，旧凭证显式作废且内容不变
const bumpedRate = (appliedRate + 0.25).toFixed(2);
let backfilled = false;
try {
  await call("/exchange-rates", { method: "POST", body: { currency: "USD", rateToBase: bumpedRate, effectiveOn: todayStr, notes: "smoke backfilled rate" } });
  backfilled = Number(bumpedRate) !== appliedRate;
} catch (error) {
  if (!String(error.message).includes("EXCHANGE_RATE_EXISTS")) throw error;
}
if (backfilled) {
  const secondRecalc = await call(`/projects/${project.data.id}/cost-recalculation`, { method: "POST" });
  assert(secondRecalc.data.unchanged === false, "Recalculation after rate backfill did not post a new voucher");
  assert(secondRecalc.data.supersedesVoucherNo === firstVoucherNo, "Old voucher was not superseded");
  const vouchers = await call(`/projects/${project.data.id}/cost-vouchers`);
  const oldVoucher = vouchers.data.find((voucher) => voucher.voucherNo === firstVoucherNo);
  assert(oldVoucher && oldVoucher.superseded === true, "Old voucher is not marked as superseded");
  const oldDetail = await call(`/cost-vouchers/${oldVoucher.id}`);
  assert(oldDetail.data.grandTotal === fmtCents(expectedLineCents(appliedRate, 90) + expectedLineCents(appliedRate, 10)), "Historical voucher content was silently rewritten");
  const newRate = appliedRate + 0.25;
  assert(secondRecalc.data.totals.totalCostBase === fmtCents(expectedLineCents(newRate, 90) + expectedLineCents(newRate, 10)), "New voucher total does not reflect the backfilled rate");
}

// 缺汇率时重算必须拒绝且不影响已有凭证
const eurBatch = await call("/batches", {
  method: "POST",
  body: { materialId: material.data.id, batchCode: `B-EUR-${suffix}`, receivedAt: todayStr, initialQuantity: "100", entryUnit: "g", totalCost: "50.00", currency: "EUR" }
});
const eurConsumption = await call("/consumptions", {
  method: "POST",
  body: { projectId: project.data.id, batchId: eurBatch.data.id, usedQuantity: "10", wasteQuantity: "0", unit: "g" }
});
let missingRateRejected = false;
try {
  await call(`/projects/${project.data.id}/cost-recalculation`, { method: "POST" });
} catch (error) {
  missingRateRejected = String(error.message).includes("MISSING_EXCHANGE_RATE");
}
assert(missingRateRejected, "Recalculation did not reject missing exchange rates");
await call(`/consumptions/${eurConsumption.data.id}/reverse`, { method: "POST", body: { reason: "Smoke test cleanup" } });
const finalRecalc = await call(`/projects/${project.data.id}/cost-recalculation`, { method: "POST" });
assert(finalRecalc.data.unchanged === true, "Final recalculation should find the current voucher up to date");

const search = await call(`/materials?${new URLSearchParams({ q: `Smoke Material ${suffix}`, craftType: "GENERAL", color: "Smoke Brown", stockState: "in_stock" })}`);
assert(search.meta.total >= 1, "Material search did not find the smoke-test material");

console.log(JSON.stringify({
  result: "PASS",
  sourceId: source.data.id,
  materialId: material.data.id,
  batchId: batch.id,
  projectId: project.data.id,
  consumptionId: consumption.id
}, null, 2));
