<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { voucherStatusLabels, voucherStatusTypes, type CostVoucher } from "@/types";

type RateRow = {
  id: string;
  currency: string;
  rateToBase: string;
  effectiveFrom: string;
  note: string | null;
  createdByName: string;
  createdAt: string;
};

const loading = ref(true);
const baseCurrency = ref("CNY");
const rates = ref<RateRow[]>([]);
const vouchers = ref<CostVoucher[]>([]);
const voucherTotal = ref(0);
const page = ref(1);
const pageSize = ref(20);
const filterStatus = ref("");

const rateForm = reactive({ currency: "USD", rateToBase: "", effectiveFrom: new Date().toISOString().slice(0, 10), note: "" });
const rateVisible = ref(false);
const savingRate = ref(false);

async function loadSettings() {
  const response = await request<{ data: { baseCurrency: string } }>("/costing/settings");
  baseCurrency.value = response.data.baseCurrency;
}

async function loadRates() {
  const response = await request<{ data: RateRow[] }>("/costing/rates?pageSize=100");
  rates.value = response.data;
}

async function loadVouchers() {
  const params = new URLSearchParams({ page: String(page.value), pageSize: String(pageSize.value) });
  if (filterStatus.value) params.set("status", filterStatus.value);
  const response = await request<{ data: CostVoucher[]; meta: { total: number } }>(`/costing/vouchers?${params}`);
  vouchers.value = response.data;
  voucherTotal.value = response.meta.total;
}

async function load() {
  loading.value = true;
  try {
    await Promise.all([loadSettings(), loadRates(), loadVouchers()]);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "成本数据加载失败");
  } finally {
    loading.value = false;
  }
}

function openRate() {
  Object.assign(rateForm, { currency: "USD", rateToBase: "", effectiveFrom: new Date().toISOString().slice(0, 10), note: "" });
  rateVisible.value = true;
}

async function saveRate() {
  savingRate.value = true;
  try {
    if (rateForm.currency.toUpperCase() === baseCurrency.value) {
      ElMessage.warning(`${baseCurrency.value} 是基准币种，不需要维护汇率`);
      return;
    }
    const response = await request<{ data: RateRow & { recompute: { created: number; unchanged: number; skipped: number } | null } }>(
      "/costing/rates",
      {
        method: "POST",
        body: {
          currency: rateForm.currency.toUpperCase(),
          rateToBase: rateForm.rateToBase,
          effectiveFrom: rateForm.effectiveFrom,
          note: rateForm.note || null
        }
      }
    );
    const summary = response.data.recompute;
    if (summary) {
      ElMessage.success(`汇率已登记，重算产生 ${summary.created} 张新版本，${summary.skipped} 张已确认凭证保持不变`);
    } else {
      ElMessage.success("汇率已登记");
    }
    rateVisible.value = false;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "汇率登记失败");
  } finally {
    savingRate.value = false;
  }
}

async function confirmVoucher(row: CostVoucher) {
  try {
    await ElMessageBox.confirm(
      "确认后凭证视为已结转/报账，后续成本或汇率补录不会自动改写它；如需更正必须显式“重开”。",
      "确认成本凭证",
      { type: "warning", confirmButtonText: "确认结转", cancelButtonText: "取消" }
    );
    const { value } = await ElMessageBox.prompt("可填写确认备注（可选）", "确认成本凭证", {
      confirmButtonText: "确认",
      cancelButtonText: "取消",
      inputValue: "",
      inputValidator: (value: string) => !value || value.length <= 500 || "备注最多 500 字"
    });
    await request(`/costing/vouchers/${row.id}/confirm`, { method: "POST", body: { remark: value || null } });
    ElMessage.success("凭证已确认");
    await loadVouchers();
  } catch (error: unknown) {
    if (error !== "cancel" && error !== "close" && !(error instanceof Error && error.message === "cancel")) {
      ElMessage.error(error instanceof ApiError ? error.message : "确认失败");
    }
  }
}

async function reopenVoucher(row: CostVoucher) {
  try {
    const { value } = await ElMessageBox.prompt(
      "重开会基于当前成本与汇率生成新版本凭证；原已确认凭证会保留为“已被新版本取代”，可在凭证链中追溯，不会被删除。",
      "重开已确认凭证",
      {
        confirmButtonText: "重开并重算",
        cancelButtonText: "取消",
        inputPlaceholder: "请说明重开原因（必填，至少 3 个字）",
        inputValidator: (input: string) => input.trim().length >= 3 || "请填写至少 3 个字的原因"
      }
    );
    await request(`/costing/vouchers/${row.id}/reopen`, { method: "POST", body: { reason: value } });
    ElMessage.success("已生成新版本凭证，原凭证保留可追溯");
    await loadVouchers();
  } catch (error: unknown) {
    if (error !== "cancel" && error !== "close") {
      ElMessage.error(error instanceof ApiError ? error.message : "重开失败");
    }
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <header class="page-header">
      <div>
        <h1>用料成本核算</h1>
        <p>按批次、用量和币种分摊采购费与损耗；基准币种：<strong>{{ baseCurrency }}</strong></p>
      </div>
      <el-button type="primary" @click="openRate">登记汇率</el-button>
    </header>

    <section class="panel">
      <h2>汇率版本（按生效日期）</h2>
      <el-table :data="rates" size="small">
        <el-table-column label="币种" prop="currency" width="100" />
        <el-table-column label="兑 {{ baseCurrency }} 汇率" prop="rateToBase" width="180" />
        <el-table-column label="生效日期" prop="effectiveFrom" width="140" />
        <el-table-column label="备注" prop="note" />
        <el-table-column label="登记人" prop="createdByName" width="140" />
      </el-table>
      <el-empty v-if="rates.length === 0" description="还没有汇率；外币批次需要先登记汇率才能算出基准币成本" />
    </section>

    <section class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h2 style="margin:0">成本凭证</h2>
        <el-radio-group v-model="filterStatus" size="small" @change="() => { page = 1; loadVouchers(); }">
          <el-radio-button value="">全部</el-radio-button>
          <el-radio-button value="DRAFT">待补录</el-radio-button>
          <el-radio-button value="ACTIVE">有效</el-radio-button>
          <el-radio-button value="CONFIRMED">已确认</el-radio-button>
          <el-radio-button value="SUPERSEDED">历史版本</el-radio-button>
        </el-radio-group>
      </div>
      <el-table :data="vouchers" size="small">
        <el-table-column label="时间" width="165">
          <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template>
        </el-table-column>
        <el-table-column label="项目 / 材料" min-width="180">
          <template #default="{ row }">
            <router-link :to="`/projects/${row.projectId}`">{{ row.projectName }}</router-link>
            <div class="muted">{{ row.materialName }} · {{ row.batchCode || row.batchId.slice(0, 8) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.eventType === 'CONSUMPTION' ? 'primary' : 'danger'">
              {{ row.eventType === "CONSUMPTION" ? "消耗" : "红冲" }}
            </el-tag>
            <span class="muted"> v{{ row.version }}</span>
          </template>
        </el-table-column>
        <el-table-column label="使用/损耗" width="150">
          <template #default="{ row }">{{ row.usedQuantity }} / {{ row.wasteQuantity }}</template>
        </el-table-column>
        <el-table-column label="原币金额" width="160">
          <template #default="{ row }">
            <span>{{ row.totalCostOrig }}</span>
            <span class="muted" v-if="row.currency"> {{ row.currency }}</span>
            <span v-else class="muted"> 待补录</span>
          </template>
        </el-table-column>
        <el-table-column :label="`基准币金额（${baseCurrency}）`" width="170">
          <template #default="{ row }">
            <strong>{{ row.totalCostBase }}</strong>
            <div class="muted" v-if="row.exchangeRate">汇率 {{ Number(row.exchangeRate).toFixed(4) }}（{{ row.exchangeRateDate }}）</div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="130">
          <template #default="{ row }">
            <el-tag size="small" :type="voucherStatusTypes[row.status]">{{ voucherStatusLabels[row.status] || row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="170">
          <template #default="{ row }">
            <el-button v-if="row.status === 'ACTIVE'" link type="primary" @click="confirmVoucher(row)">确认结转</el-button>
            <el-button v-if="row.status === 'CONFIRMED'" link type="warning" @click="reopenVoucher(row)">重开重算</el-button>
            <el-button v-if="row.status === 'DRAFT'" link type="primary" :to="`/batches/${row.batchId}`">去补录</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination
        style="margin-top:12px"
        layout="total, prev, pager, next"
        :total="voucherTotal"
        :page-size="pageSize"
        :current-page="page"
        @current-change="(value: number) => { page = value; loadVouchers(); }"
      />
    </section>

    <el-dialog v-model="rateVisible" title="登记币种汇率" width="480px">
      <el-form label-position="top">
        <el-form-item label="币种（3 位代码）" required>
          <el-input v-model="rateForm.currency" maxlength="3" placeholder="USD / EUR / JPY" style="text-transform:uppercase" />
        </el-form-item>
        <el-form-item :label="`1 单位外币兑换 ${baseCurrency} 的汇率`" required>
          <el-input v-model="rateForm.rateToBase" placeholder="例如 7.1823" />
        </el-form-item>
        <el-form-item label="生效日期" required>
          <el-date-picker v-model="rateForm.effectiveFrom" type="date" value-format="YYYY-MM-DD" style="width:100%" />
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="rateForm.note" type="textarea" :rows="2" maxlength="500" /></el-form-item>
      </el-form>
      <p class="muted" style="font-size:12px">同一币种同一生效日期只允许一个版本；补录历史日期后，该日期之后的待补录/有效凭证会自动重算，已确认凭证不变。</p>
      <template #footer>
        <el-button @click="rateVisible = false">取消</el-button>
        <el-button type="primary" :loading="savingRate" @click="saveRate">登记并重算</el-button>
      </template>
    </el-dialog>
  </div>
</template>
