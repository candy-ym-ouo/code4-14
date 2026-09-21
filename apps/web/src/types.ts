export type ApiMeta = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type Material = {
  id: string;
  code: string | null;
  name: string;
  craftTypes: string[];
  subtype: string | null;
  stockUnit: string;
  lowStockThreshold: string | null;
  defaultColorName: string | null;
  defaultColorHex: string | null;
  tags: string[];
  notes: string | null;
  remainingQuantity: string;
  batchCount: number;
  stockState: string;
  archivedAt: string | null;
  updatedAt: string;
  version: number;
};

export type Batch = {
  id: string;
  materialId: string;
  materialName: string;
  materialCode: string | null;
  batchCode: string | null;
  sourceId: string | null;
  sourceName: string | null;
  locationId: string | null;
  locationName: string | null;
  receivedAt: string;
  expiryAt: string | null;
  initialQuantity: string;
  remainingQuantity: string;
  stockUnit: string;
  currentColorName: string | null;
  currentColorHex: string | null;
  status: string;
  notes: string | null;
  version: number;
  updatedAt: string;
};

export type Source = {
  id: string;
  name: string;
  type: string;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  address: string | null;
  notes: string | null;
  archivedAt: string | null;
  batchCount: number;
  activeBatchCount: number;
};

export type Location = {
  id: string;
  name: string;
  parentId: string | null;
  notes: string | null;
  batchCount: number;
  archivedAt: string | null;
};

export type Project = {
  id: string;
  name: string;
  craftType: string;
  status: string;
  startDate: string | null;
  dueDate: string | null;
  completedAt: string | null;
  description: string | null;
  targetColorName: string | null;
  targetColorHex: string | null;
  tags: string[];
  requirementCount: number;
  consumptionCount: number;
  version: number;
  updatedAt: string;
};

export type Consumption = {
  id: string;
  projectId: string;
  projectName: string;
  projectRequirementId: string | null;
  batchId: string;
  batchCode: string | null;
  materialId: string;
  materialName: string;
  sourceName: string | null;
  usedQuantity: string;
  wasteQuantity: string;
  totalQuantity: string;
  stockUnit: string;
  consumedAt: string;
  purpose: string | null;
  notes: string | null;
  status: string;
  reversedAt: string | null;
  reversalReason: string | null;
};

export const craftTypeLabels: Record<string, string> = {
  DYEING: "染布",
  WOODWORKING: "木工",
  POTTERY: "陶艺",
  METALWORKING: "金工",
  GENERAL: "通用",
  OTHER: "其他"
};

export const statusLabels: Record<string, string> = {
  ACTIVE: "有库存",
  DEPLETED: "已耗尽",
  ARCHIVED: "已归档",
  PLANNED: "计划中",
  IN_PROGRESS: "进行中",
  COMPLETED: "已完成",
  REVERSED: "已撤销"
};

export const movementLabels: Record<string, string> = {
  OPENING: "初始入库",
  PURCHASE: "采购入库",
  CONSUMPTION: "材料消耗",
  ADJUSTMENT_IN: "盘增",
  ADJUSTMENT_OUT: "盘减",
  REVERSAL: "撤销恢复"
};

export type CostSettings = {
  baseCurrency: string | null;
  locked: boolean;
  updatedAt: string | null;
};

export type ExchangeRate = {
  id: string;
  currency: string;
  rateToBase: string;
  effectiveOn: string;
  notes: string | null;
  createdAt: string;
};

export type CostAdjustment = {
  id: string;
  feeType: string;
  amount: string;
  currency: string;
  incurredOn: string;
  notes: string | null;
  createdAt: string;
};

export type CostSummaryLine = {
  consumptionId: string;
  batchId: string;
  materialId: string | null;
  materialName: string | null;
  batchCode: string | null;
  stockUnit: string | null;
  usedQuantity: string;
  wasteQuantity: string;
  currency: string | null;
  priced: boolean;
  batchTotalCostBase: string | null;
  unitCostBase: string | null;
  fxRate: string | null;
  usedCostBase: string | null;
  wasteCostBase: string | null;
  totalCostBase: string | null;
};

export type CostSummary = {
  configured: boolean;
  baseCurrency?: string;
  lines?: CostSummaryLine[];
  totals?: {
    usedCostBase: string;
    wasteCostBase: string;
    totalCostBase: string;
    pricedLineCount: number;
    unpricedLineCount: number;
  };
  missingRates?: { currency: string; onDate: string }[];
  warnings?: string[];
  voucher?: { id: string; voucherNo: string; createdAt: string; upToDate: boolean } | null;
};

export type CostVoucherListItem = {
  id: string;
  voucherNo: string;
  baseCurrency: string;
  lineCount: number;
  pricedLineCount: number;
  usedTotal: string;
  wasteTotal: string;
  grandTotal: string;
  createdAt: string;
  superseded: boolean;
  supersededAt: string | null;
  supersededByVoucherNo: string | null;
};

export type CostVoucherLine = {
  lineNo: number;
  consumptionId: string;
  batchId: string;
  batchCode: string | null;
  materialName: string;
  usedQuantity: string;
  wasteQuantity: string;
  stockUnit: string;
  currency: string | null;
  priced: boolean;
  batchTotalCostBase: string | null;
  unitCostBase: string | null;
  fxRate: string | null;
  usedCostBase: string | null;
  wasteCostBase: string | null;
  totalCostBase: string | null;
};

export type CostVoucherDetail = CostVoucherListItem & {
  projectId: string;
  projectName: string;
  linesHash: string;
  supersedesVoucherNo: string | null;
  lines: CostVoucherLine[];
};
