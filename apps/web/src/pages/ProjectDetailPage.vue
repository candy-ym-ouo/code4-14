<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { craftTypeLabels, statusLabels, type CostSummary, type CostVoucherDetail, type CostVoucherListItem, type Material } from "@/types";
import AttachmentPanel from "@/components/AttachmentPanel.vue";

const route = useRoute();
const router = useRouter();
const loading = ref(true);
const saving = ref(false);
const project = ref<any>(null);
const materials = ref<Material[]>([]);
const requirementVisible = ref(false);
const requirementForm = reactive({ materialId: "", requiredQuantity: "", unit: "g", purpose: "", notes: "" });
const isReadOnly = computed(() => ["COMPLETED", "ARCHIVED"].includes(project.value?.status));
const costSummary = ref<CostSummary | null>(null);
const vouchers = ref<CostVoucherListItem[]>([]);
const recalculating = ref(false);
const voucherDetail = ref<CostVoucherDetail | null>(null);
const voucherVisible = ref(false);

async function load() {
  loading.value = true;
  try {
    const [projectResponse, materialResponse] = await Promise.all([
      request<{ data: any }>(`/projects/${route.params.id}`),
      request<{ data: Material[] }>("/materials?pageSize=100")
    ]);
    project.value = projectResponse.data;
    materials.value = materialResponse.data;
    await loadCosts();
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "项目加载失败"); }
  finally { loading.value = false; }
}

async function loadCosts() {
  try {
    const summaryResponse = await request<{ data: CostSummary }>(`/projects/${route.params.id}/cost-summary`);
    costSummary.value = summaryResponse.data;
    if (summaryResponse.data.configured) {
      const voucherResponse = await request<{ data: CostVoucherListItem[] }>(`/projects/${route.params.id}/cost-vouchers`);
      vouchers.value = voucherResponse.data;
    }
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "成本数据加载失败"); }
}

async function recalculate() {
  recalculating.value = true;
  try {
    const response = await request<{ data: { unchanged: boolean; voucher: { voucherNo: string } | null; supersedesVoucherNo: string | null } }>(
      `/projects/${route.params.id}/cost-recalculation`,
      { method: "POST" }
    );
    if (response.data.unchanged) {
      ElMessage.success(response.data.voucher ? `成本未发生变化，当前凭证 ${response.data.voucher.voucherNo} 仍然有效` : "没有需要过账的成本数据");
    } else if (response.data.voucher) {
      ElMessage.success(
        response.data.supersedesVoucherNo
          ? `已生成新凭证 ${response.data.voucher.voucherNo}，原凭证 ${response.data.supersedesVoucherNo} 已作废保留`
          : `成本凭证 ${response.data.voucher.voucherNo} 已过账`
      );
    }
    await loadCosts();
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "成本重算失败"); }
  finally { recalculating.value = false; }
}

async function openVoucher(id: string) {
  try {
    const response = await request<{ data: CostVoucherDetail }>(`/cost-vouchers/${id}`);
    voucherDetail.value = response.data;
    voucherVisible.value = true;
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "凭证加载失败"); }
}
function openRequirement() {
  Object.assign(requirementForm, { materialId: "", requiredQuantity: "", unit: "g", purpose: "", notes: "" });
  requirementVisible.value = true;
}
function materialChanged(id: string) {
  const material = materials.value.find((item) => item.id === id);
  if (material) requirementForm.unit = material.stockUnit;
}
async function addRequirement() {
  saving.value = true;
  try {
    await request(`/projects/${project.value.id}/requirements`, { method: "POST", body: { ...requirementForm, purpose: requirementForm.purpose || null, notes: requirementForm.notes || null } });
    ElMessage.success("材料需求已添加"); requirementVisible.value = false; await load();
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "添加失败"); }
  finally { saving.value = false; }
}
async function deleteRequirement(id: string) {
  try {
    await ElMessageBox.confirm("只有尚未产生消耗的需求可以删除。", "删除材料需求", { type: "warning" });
    await request(`/projects/${project.value.id}/requirements/${id}`, { method: "DELETE" }); await load();
  } catch (error: any) { if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof ApiError ? error.message : "删除失败"); }
}
async function changeStatus(status: string) {
  const label = statusLabels[status] || status;
  try {
    if (status === "COMPLETED") await ElMessageBox.confirm("完成后项目默认只读，重新打开后才能继续消耗。", "完成项目", { type: "warning" });
    await request(`/projects/${project.value.id}/status`, { method: "POST", body: { status, version: project.value.version } });
    ElMessage.success(`项目状态已更新为${label}`); await load();
  } catch (error: any) { if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof ApiError ? error.message : "状态更新失败"); }
}
onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <template v-if="project">
      <header class="page-header">
        <div><h1>{{ project.name }}</h1><p>{{ craftTypeLabels[project.craftType] || project.craftType }} · {{ statusLabels[project.status] || project.status }}</p></div>
        <div>
          <el-button :disabled="isReadOnly" @click="router.push(`/projects/${project.id}/edit`)">编辑</el-button>
          <el-button v-if="project.status==='PLANNED'" type="primary" @click="changeStatus('IN_PROGRESS')">开始项目</el-button>
          <el-button v-if="project.status==='IN_PROGRESS'" type="success" @click="changeStatus('COMPLETED')">完成项目</el-button>
          <el-button v-if="project.status==='COMPLETED'" @click="changeStatus('IN_PROGRESS')">重新打开</el-button>
          <el-button :disabled="isReadOnly" type="primary" plain @click="router.push({ path: '/consumptions', query: { projectId: project.id, create: '1' } })">记录消耗</el-button>
        </div>
      </header>
      <section class="panel">
        <el-descriptions :column="3" border>
          <el-descriptions-item label="开始日期">{{ project.startDate || "未设定" }}</el-descriptions-item>
          <el-descriptions-item label="截止日期">{{ project.dueDate || "未设定" }}</el-descriptions-item>
          <el-descriptions-item label="完成时间">{{ project.completedAt ? new Date(project.completedAt).toLocaleString() : "未完成" }}</el-descriptions-item>
          <el-descriptions-item label="目标颜色"><span v-if="project.targetColorHex" class="color-dot" :style="{ background: project.targetColorHex }" />{{ project.targetColorName || "未设定" }}</el-descriptions-item>
          <el-descriptions-item label="标签" :span="2">{{ project.tags?.join("、") || "无" }}</el-descriptions-item>
          <el-descriptions-item label="说明" :span="3">{{ project.description || "无" }}</el-descriptions-item>
        </el-descriptions>
      </section>

      <section class="panel">
        <div style="display:flex;justify-content:space-between;align-items:center"><h2>材料需求与实际消耗</h2><el-button :disabled="isReadOnly" type="primary" @click="openRequirement">添加材料需求</el-button></div>
        <el-table :data="project.requirements">
          <el-table-column label="材料" min-width="180"><template #default="{ row }"><router-link :to="`/materials/${row.materialId}`">{{ row.materialName }}</router-link><div class="muted">{{ row.purpose || "未填写用途" }}</div></template></el-table-column>
          <el-table-column label="计划数量" width="150"><template #default="{ row }">{{ row.requiredQuantity }} {{ row.stockUnit }}</template></el-table-column>
          <el-table-column label="实际使用" width="150"><template #default="{ row }">{{ row.usedQuantity }} {{ row.stockUnit }}</template></el-table-column>
          <el-table-column label="损耗" width="150"><template #default="{ row }">{{ row.wasteQuantity }} {{ row.stockUnit }}</template></el-table-column>
          <el-table-column label="消耗笔数" prop="consumptionCount" width="100" />
          <el-table-column label="操作" width="110"><template #default="{ row }"><el-button link type="danger" :disabled="row.referenceCount>0 || isReadOnly" @click="deleteRequirement(row.id)">删除</el-button></template></el-table-column>
        </el-table>
        <el-empty v-if="project.requirements.length===0" description="还没有计划用料" />
      </section>

      <AttachmentPanel owner-type="PROJECT" :owner-id="project.id" :attachments="project.attachments" @changed="load" />

      <section class="panel">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h2>用料成本核算<span v-if="costSummary?.configured" class="muted" style="font-weight:normal">（本位币：{{ costSummary.baseCurrency }}）</span></h2>
          <el-button v-if="costSummary?.configured" type="primary" :loading="recalculating" :disabled="(costSummary.missingRates?.length ?? 0) > 0" @click="recalculate">重算并过账</el-button>
        </div>
        <el-alert v-if="costSummary && !costSummary.configured" type="info" show-icon :closable="false"
          title="尚未配置成本核算本位币">
          <template #default>请先到<router-link to="/settings">设置</router-link>中配置本位币与汇率，之后即可按批次、用量和币种核算项目用料成本。</template>
        </el-alert>
        <template v-else-if="costSummary">
          <el-alert v-if="(costSummary.missingRates?.length ?? 0) > 0" type="warning" show-icon :closable="false" style="margin-bottom:12px"
            :title="`缺少汇率：${costSummary.missingRates!.map((item) => `${item.currency}（${item.onDate} 前生效）`).join('、')}。请在设置中补录汇率后再重算。`" />
          <el-alert v-if="costSummary.voucher && !costSummary.voucher.upToDate" type="warning" show-icon :closable="false" style="margin-bottom:12px"
            :title="`成本输入已变化（汇率、费用或消耗更新），当前凭证 ${costSummary.voucher.voucherNo} 不是最新。重算后将生成新凭证，历史凭证保留可查。`" />
          <el-alert v-for="warning in costSummary.warnings ?? []" :key="warning" type="warning" show-icon :closable="false" style="margin-bottom:12px" :title="warning" />
          <div v-if="costSummary.totals" class="stat-grid" style="margin-bottom:12px">
            <article class="stat-card"><small>实际使用成本</small><strong>{{ costSummary.totals.usedCostBase }} {{ costSummary.baseCurrency }}</strong></article>
            <article class="stat-card"><small>损耗成本</small><strong>{{ costSummary.totals.wasteCostBase }} {{ costSummary.baseCurrency }}</strong></article>
            <article class="stat-card"><small>成本合计</small><strong>{{ costSummary.totals.totalCostBase }} {{ costSummary.baseCurrency }}</strong></article>
            <article class="stat-card"><small>当前凭证</small><strong>
              <template v-if="costSummary.voucher">{{ costSummary.voucher.voucherNo }} <el-tag size="small" :type="costSummary.voucher.upToDate ? 'success' : 'warning'">{{ costSummary.voucher.upToDate ? "最新" : "已过期" }}</el-tag></template>
              <template v-else>尚未过账</template>
            </strong></article>
          </div>
          <el-table :data="costSummary.lines ?? []" size="small">
            <el-table-column label="材料/批次" min-width="160"><template #default="{ row }">{{ row.materialName }}<div class="muted">{{ row.batchCode || row.batchId }}</div></template></el-table-column>
            <el-table-column label="使用/损耗" width="130"><template #default="{ row }">{{ row.usedQuantity }} / {{ row.wasteQuantity }} {{ row.stockUnit }}</template></el-table-column>
            <el-table-column label="批次成本(本位币)" width="130" align="right"><template #default="{ row }">{{ row.priced ? row.batchTotalCostBase : "未定价" }}</template></el-table-column>
            <el-table-column label="币种" width="70"><template #default="{ row }">{{ row.currency || "—" }}</template></el-table-column>
            <el-table-column label="汇率" width="100" align="right"><template #default="{ row }">{{ row.fxRate ?? "—" }}</template></el-table-column>
            <el-table-column label="使用成本" width="110" align="right"><template #default="{ row }">{{ row.usedCostBase ?? "—" }}</template></el-table-column>
            <el-table-column label="损耗成本" width="110" align="right"><template #default="{ row }">{{ row.wasteCostBase ?? "—" }}</template></el-table-column>
            <el-table-column label="行合计" width="110" align="right"><template #default="{ row }"><strong>{{ row.totalCostBase ?? "—" }}</strong></template></el-table-column>
          </el-table>
          <el-empty v-if="(costSummary.lines ?? []).length === 0" description="还没有有效消耗，暂无成本数据" />
          <template v-if="vouchers.length > 0">
            <h3 style="margin-top:20px">成本凭证历史</h3>
            <el-table :data="vouchers" size="small">
              <el-table-column label="凭证号" width="180"><template #default="{ row }"><el-button link type="primary" @click="openVoucher(row.id)">{{ row.voucherNo }}</el-button></template></el-table-column>
              <el-table-column label="过账时间" width="170"><template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template></el-table-column>
              <el-table-column label="行数" prop="lineCount" width="70" />
              <el-table-column label="成本合计" width="130" align="right"><template #default="{ row }">{{ row.grandTotal }} {{ row.baseCurrency }}</template></el-table-column>
              <el-table-column label="状态" min-width="160"><template #default="{ row }">
                <el-tag v-if="row.superseded" type="info">已作废 → {{ row.supersededByVoucherNo }}</el-tag>
                <el-tag v-else type="success">当前有效</el-tag>
              </template></el-table-column>
            </el-table>
          </template>
        </template>
      </section>

      <div class="two-column">
        <section class="panel">
          <h2>消耗记录</h2>
          <el-table :data="project.consumptions" size="small">
            <el-table-column label="时间" width="170"><template #default="{ row }">{{ new Date(row.consumedAt).toLocaleString() }}</template></el-table-column>
            <el-table-column label="材料/批次"><template #default="{ row }">{{ row.materialName }}<div class="muted">{{ row.batchCode || row.batchId }}</div></template></el-table-column>
            <el-table-column label="使用/损耗" width="140"><template #default="{ row }">{{ row.usedQuantity }} / {{ row.wasteQuantity }} {{ row.stockUnit }}</template></el-table-column>
            <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="row.status==='ACTIVE'?'success':'info'">{{ statusLabels[row.status] || row.status }}</el-tag></template></el-table-column>
          </el-table>
          <el-empty v-if="project.consumptions.length===0" description="还没有实际消耗" />
        </section>
        <section class="panel">
          <h2>项目颜色变化</h2>
          <el-timeline v-if="project.colorChanges.length"><el-timeline-item v-for="item in project.colorChanges" :key="item.id" :timestamp="new Date(item.occurredAt).toLocaleString()"><strong>{{ item.beforeColorName || "未记录" }} → {{ item.afterColorName }}</strong></el-timeline-item></el-timeline>
          <el-empty v-else description="还没有关联颜色变化" />
        </section>
      </div>
    </template>

    <el-dialog v-model="voucherVisible" :title="'成本凭证 ' + (voucherDetail?.voucherNo ?? '')" width="960px">
      <template v-if="voucherDetail">
        <el-alert v-if="voucherDetail.superseded" type="info" show-icon :closable="false" style="margin-bottom:12px"
          :title="`该凭证已被 ${voucherDetail.supersededByVoucherNo} 作废替代，内容保持原样仅供查阅，不会被修改。`" />
        <el-descriptions :column="4" border size="small" style="margin-bottom:12px">
          <el-descriptions-item label="项目">{{ voucherDetail.projectName }}</el-descriptions-item>
          <el-descriptions-item label="过账时间">{{ new Date(voucherDetail.createdAt).toLocaleString() }}</el-descriptions-item>
          <el-descriptions-item label="本位币">{{ voucherDetail.baseCurrency }}</el-descriptions-item>
          <el-descriptions-item label="替代凭证">{{ voucherDetail.supersedesVoucherNo || "无" }}</el-descriptions-item>
          <el-descriptions-item label="使用成本">{{ voucherDetail.usedTotal }}</el-descriptions-item>
          <el-descriptions-item label="损耗成本">{{ voucherDetail.wasteTotal }}</el-descriptions-item>
          <el-descriptions-item label="成本合计">{{ voucherDetail.grandTotal }}</el-descriptions-item>
          <el-descriptions-item label="定价行数">{{ voucherDetail.pricedLineCount }} / {{ voucherDetail.lineCount }}</el-descriptions-item>
        </el-descriptions>
        <el-table :data="voucherDetail.lines" size="small" max-height="420">
          <el-table-column label="#" prop="lineNo" width="50" />
          <el-table-column label="材料/批次" min-width="150"><template #default="{ row }">{{ row.materialName }}<div class="muted">{{ row.batchCode || row.batchId }}</div></template></el-table-column>
          <el-table-column label="使用/损耗" width="130"><template #default="{ row }">{{ row.usedQuantity }} / {{ row.wasteQuantity }} {{ row.stockUnit }}</template></el-table-column>
          <el-table-column label="批次总成本" width="110" align="right"><template #default="{ row }">{{ row.batchTotalCostBase ?? "未定价" }}</template></el-table-column>
          <el-table-column label="单位成本" width="110" align="right"><template #default="{ row }">{{ row.unitCostBase ?? "—" }}</template></el-table-column>
          <el-table-column label="币种" width="65"><template #default="{ row }">{{ row.currency || "—" }}</template></el-table-column>
          <el-table-column label="汇率" width="95" align="right"><template #default="{ row }">{{ row.fxRate ?? "—" }}</template></el-table-column>
          <el-table-column label="使用成本" width="100" align="right"><template #default="{ row }">{{ row.usedCostBase ?? "—" }}</template></el-table-column>
          <el-table-column label="损耗成本" width="100" align="right"><template #default="{ row }">{{ row.wasteCostBase ?? "—" }}</template></el-table-column>
          <el-table-column label="行合计" width="100" align="right"><template #default="{ row }"><strong>{{ row.totalCostBase ?? "—" }}</strong></template></el-table-column>
        </el-table>
      </template>
    </el-dialog>

    <el-dialog v-model="requirementVisible" title="添加材料需求" width="560px">
      <el-form label-position="top">
        <el-form-item label="材料" required><el-select v-model="requirementForm.materialId" filterable style="width:100%" @change="materialChanged"><el-option v-for="material in materials" :key="material.id" :value="material.id" :label="`${material.name}（${material.stockUnit}）`" /></el-select></el-form-item>
        <el-form-item label="计划数量" required><el-input v-model="requirementForm.requiredQuantity" /></el-form-item>
        <el-form-item label="单位"><el-select v-model="requirementForm.unit" style="width:100%"><el-option v-for="unit in ['g','kg','ml','l','mm','cm','m','m2','pcs']" :key="unit" :value="unit" :label="unit" /></el-select></el-form-item>
        <el-form-item label="用途"><el-input v-model="requirementForm.purpose" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="requirementForm.notes" type="textarea" :rows="3" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="requirementVisible=false">取消</el-button><el-button type="primary" :loading="saving" @click="addRequirement">添加</el-button></template>
    </el-dialog>
  </div>
</template>
