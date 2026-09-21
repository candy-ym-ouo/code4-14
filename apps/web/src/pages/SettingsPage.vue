<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { request, ApiError, download } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import type { CostSettings, ExchangeRate } from "@/types";

const router = useRouter();
const auth = useAuthStore();
const saving = ref(false);
const form = reactive({ currentPassword: "", newPassword: "", confirmPassword: "" });
const costSettings = ref<CostSettings | null>(null);
const baseCurrencyInput = ref("");
const costSaving = ref(false);
const rates = ref<ExchangeRate[]>([]);
const rateVisible = ref(false);
const rateSaving = ref(false);
const rateForm = reactive({ currency: "", rateToBase: "", effectiveOn: "", notes: "" });
const commonCurrencies = ["CNY", "USD", "EUR", "JPY", "HKD", "GBP", "TWD", "KRW"];

async function exportFile(path: string) {
  try {
    await download(path);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "导出失败");
  }
}
async function changePassword() {
  if (form.newPassword !== form.confirmPassword) { ElMessage.error("两次输入的新密码不一致"); return; }
  saving.value = true;
  try {
    await request<void>("/auth/password", { method: "POST", body: { currentPassword: form.currentPassword, newPassword: form.newPassword } });
    auth.user = null;
    ElMessage.success("密码已修改，请重新登录");
    await router.push("/login");
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "密码修改失败"); }
  finally { saving.value = false; }
}

async function loadCosts() {
  try {
    const [settingsResponse, ratesResponse] = await Promise.all([
      request<{ data: CostSettings }>("/settings/cost"),
      request<{ data: ExchangeRate[] }>("/exchange-rates?pageSize=100")
    ]);
    costSettings.value = settingsResponse.data;
    baseCurrencyInput.value = settingsResponse.data.baseCurrency ?? "";
    rates.value = ratesResponse.data;
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "成本设置加载失败"); }
}

async function saveBaseCurrency() {
  if (!/^[A-Za-z]{3}$/.test(baseCurrencyInput.value.trim())) { ElMessage.error("本位币必须是 3 位字母代码"); return; }
  costSaving.value = true;
  try {
    await request("/settings/cost", { method: "PUT", body: { baseCurrency: baseCurrencyInput.value.trim() } });
    ElMessage.success("本位币已保存");
    await loadCosts();
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "本位币保存失败"); }
  finally { costSaving.value = false; }
}

function openRateDialog() {
  Object.assign(rateForm, { currency: "", rateToBase: "", effectiveOn: new Date().toISOString().slice(0, 10), notes: "" });
  rateVisible.value = true;
}

async function submitRate() {
  if (!/^[A-Za-z]{3}$/.test(rateForm.currency.trim()) || !rateForm.rateToBase || !rateForm.effectiveOn) {
    ElMessage.error("请填写币种、汇率和生效日期");
    return;
  }
  rateSaving.value = true;
  try {
    await request("/exchange-rates", {
      method: "POST",
      body: { ...rateForm, currency: rateForm.currency.trim(), notes: rateForm.notes || null }
    });
    ElMessage.success("汇率已录入，相关项目重算后生效");
    rateVisible.value = false;
    await loadCosts();
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "汇率录入失败"); }
  finally { rateSaving.value = false; }
}

onMounted(loadCosts);
</script>

<template>
  <div>
    <header class="page-header"><div><h1>设置与数据</h1><p>导出真实工作区数据，或更新操作员密码。</p></div></header>
    <div class="two-column">
      <section class="panel">
        <h2>数据导出</h2>
        <p class="muted">导出内容来自 PostgreSQL 当前数据，不生成任何占位数据。</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <el-button @click="exportFile('/exports/materials.csv')">导出材料 CSV</el-button>
          <el-button @click="exportFile('/exports/batches.csv')">导出批次 CSV</el-button>
          <el-button type="primary" @click="exportFile('/exports/workspace.json')">导出完整工作区 JSON</el-button>
        </div>
        <h3 style="margin-top:28px">运维说明</h3>
        <p class="muted">应定期备份 PostgreSQL 数据库和附件目录。生产环境必须使用强密码、HTTPS 和持久化存储。</p>
      </section>
      <section class="panel">
        <h2>修改密码</h2>
        <el-form label-position="top">
          <el-form-item label="当前密码"><el-input v-model="form.currentPassword" type="password" show-password /></el-form-item>
          <el-form-item label="新密码"><el-input v-model="form.newPassword" type="password" show-password placeholder="至少 10 位" /></el-form-item>
          <el-form-item label="确认新密码"><el-input v-model="form.confirmPassword" type="password" show-password /></el-form-item>
          <el-button type="primary" :loading="saving" @click="changePassword">修改密码</el-button>
        </el-form>
      </section>
    </div>

    <div class="two-column" style="margin-top:16px">
      <section class="panel">
        <h2>成本核算</h2>
        <p class="muted">项目用料成本按批次、用量和币种分摊，统一折算为本位币。存在已过账凭证后本位币不可再修改。</p>
        <el-form label-position="top" @submit.prevent>
          <el-form-item :label="costSettings?.locked ? '本位币（已锁定，存在成本凭证）' : '本位币'">
            <div style="display:flex;gap:10px;width:100%">
              <el-select v-model="baseCurrencyInput" filterable allow-create :disabled="costSettings?.locked" style="flex:1">
                <el-option v-for="currency in commonCurrencies" :key="currency" :value="currency" :label="currency" />
              </el-select>
              <el-button v-if="!costSettings?.locked" type="primary" :loading="costSaving" @click="saveBaseCurrency">保存</el-button>
            </div>
          </el-form-item>
        </el-form>
        <el-alert v-if="costSettings?.locked" type="info" show-icon :closable="false" title="本位币已锁定" />
      </section>
      <section class="panel">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h2>汇率</h2>
          <el-button :disabled="!costSettings?.baseCurrency" @click="openRateDialog">录入汇率</el-button>
        </div>
        <p class="muted">1 单位外币 = 汇率 × 本位币，按业务发生日取「不晚于当日」的最新汇率。汇率记录不可修改，修正请按新生效日期补录。</p>
        <el-table :data="rates" size="small" max-height="320">
          <el-table-column label="币种" prop="currency" width="80" />
          <el-table-column label="汇率" prop="rateToBase" width="120" align="right" />
          <el-table-column label="生效日期" prop="effectiveOn" width="110" />
          <el-table-column label="备注" min-width="120"><template #default="{ row }">{{ row.notes || "—" }}</template></el-table-column>
          <el-table-column label="录入时间" width="165"><template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template></el-table-column>
        </el-table>
        <el-empty v-if="rates.length === 0" description="还没有汇率记录" />
      </section>
    </div>

    <el-dialog v-model="rateVisible" title="录入汇率" width="480px">
      <el-form label-position="top">
        <el-form-item label="币种" required>
          <el-select v-model="rateForm.currency" filterable allow-create style="width:100%">
            <el-option v-for="currency in commonCurrencies.filter((item) => item !== costSettings?.baseCurrency)" :key="currency" :value="currency" :label="currency" />
          </el-select>
        </el-form-item>
        <el-form-item :label="'汇率（1 ' + (rateForm.currency || '外币') + ' = ? ' + (costSettings?.baseCurrency ?? '本位币') + '）'" required><el-input v-model="rateForm.rateToBase" placeholder="最多 8 位小数，如 7.125" /></el-form-item>
        <el-form-item label="生效日期" required><el-date-picker v-model="rateForm.effectiveOn" type="date" value-format="YYYY-MM-DD" style="width:100%" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="rateForm.notes" placeholder="例如：银行月末中间价" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="rateVisible = false">取消</el-button><el-button type="primary" :loading="rateSaving" @click="submitRate">保存</el-button></template>
    </el-dialog>
  </div>
</template>
