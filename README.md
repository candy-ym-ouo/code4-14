# 手工艺材料追踪器

面向染布、木工、陶艺和金工爱好者的真实库存与项目材料追踪系统。

系统记录材料来源、批次、颜色变化、剩余数量、项目计划用料和实际消耗。前端使用 Vue 3，后端使用 Node.js + Fastify，业务数据保存在 PostgreSQL。项目不提供演示模式，不预置虚假材料、项目或统计数字。

## 已实现能力

- 首次初始化、单操作员登录和密码修改。
- 来源与存放位置管理。
- 材料档案、工艺类型、单位、低库存阈值和颜色档案。
- 批次入库、来源追溯、有效期和库存流水。
- 库存调整、自动耗尽、归档和并发余额保护。
- 项目、材料需求、计划与实际消耗对比。
- 消耗、损耗、撤销和反向库存流水。
- 项目用料成本核算：按批次、使用量/损耗量和币种分摊采购费，支持采购费补录、多币种汇率版本、稳定重算和只追加成本凭证。
- 颜色变化时间线和批次当前颜色。
- 材料、批次、来源、颜色、库存状态和位置搜索筛选。
- 受保护图片附件。
- CSV、完整工作区 JSON 导出。
- 仪表盘、审计日志和健康检查。
- PostgreSQL 数据持久化和本地附件文件存储。

## 技术栈

| 层 | 技术 |
| --- | --- |
| Web | Vue 3、TypeScript、Vite、Pinia、Vue Router、Element Plus |
| API | Node.js 22、TypeScript、Fastify、Zod |
| 数据库 | PostgreSQL 16、SQL migrations、不可变库存流水 |
| 鉴权 | Argon2id、HttpOnly 会话 Cookie |
| 测试 | Vitest、API smoke test、生产构建检查 |

## 目录

```text
origin/
├── apps/
│   ├── api/                 Node.js API、SQL migrations、测试
│   └── web/                 Vue 3 前端
├── packages/
│   └── contracts/           前后端共享枚举、校验和单位换算
├── ops/
│   ├── healthcheck.sh
│   └── smoke-test.mjs
├── docs/
│   └── api.md
└── .env.example
```

## 本地开发

要求：

- Node.js 22+ 和 pnpm 10。
- PostgreSQL 16。

```bash
cd origin
pnpm install
cp .env.example .env
# 将 DATABASE_URL 指向可用的 PostgreSQL 16，并设置 SESSION_SECRET
pnpm db:migrate
pnpm dev
```

开发地址：

- Web：`http://localhost:5173`
- API：`http://localhost:3000`

`.env` 会被 API 自动加载，Web 的 Vite 代理会把 `/api` 转发到本地 API。首次打开会进入初始化页面；系统只创建一个操作员，不提供公开注册。

## 测试与构建

```bash
pnpm typecheck
pnpm test
pnpm build
```

对已初始化的运行环境执行完整 API 验收链：

```bash
SMOKE_BASE_URL=http://127.0.0.1:8080 \
SMOKE_PASSWORD='你的操作员密码' \
node ops/smoke-test.mjs
```

验收脚本会真实创建来源、材料、批次、项目、需求、消耗和颜色变化，验证余额从 1000g 降到 500g、撤销后恢复 1000g、最新流水为 `REVERSAL`、颜色和搜索正确。

建议只在专用验收数据库执行该脚本，因为它会留下测试业务数据。

## 业务一致性

- 批次是库存的最小核算单位，材料列表只做聚合。
- 创建批次和首条 `OPENING` 流水在同一事务完成。
- 消耗、调整和撤销都在事务中锁定批次。
- 批次余额绝不允许小于 0。
- 消耗记录保存实际使用量和损耗量，总扣减量等于两者之和。
- 撤销不删除历史，而是新增 `REVERSAL` 流水。
- 项目用料成本按批次成本层（入库采购费 + 历次补录）和使用量/损耗量分摊；损耗成本计入其所属项目。
- 采购费补录只追加（`batch_cost_adjustments`），追加分摊基数为登记时批次剩余数量；入库成本列永不被改写。
- 汇率按“币种 + 生效日期”做版本序列，消耗按其发生日期取对应汇率；补录新日期汇率不覆盖历史版本。
- 成本凭证只追加：金额、数量、汇率、依据受数据库触发器保护不可更新，DELETE 被禁止；重算通过版本链追加新版本，旧版本转为 `SUPERSEDED`。
- `CONFIRMED`（已结转/报账）凭证不参与自动重算，只能显式重开并填写原因，历史凭证仍可追溯。
- 重算以计价依据指纹判定：依据未变不产生新版本；金额全程定点整数运算，使用与损耗分项之和严格等于总额。
- 颜色变化更新当前颜色快照，但不自动修改库存。
- 计划用料不扣库存，实际消耗才扣库存。
- 数量使用 PostgreSQL `numeric(18,6)`，API 使用十进制字符串。
- 归档代替核心数据硬删除。
- 审计日志只追加，不更新、不删除。

## 文档

- [API 文档](docs/api.md)

## 数据安全

- 修改 `.env.example` 中的默认数据库密码。
- 使用 `openssl rand -hex 32` 生成 `SESSION_SECRET`。
- 生产环境设置 `COOKIE_SECURE=true` 并使用 HTTPS。
- 定期备份 PostgreSQL 数据库和 `UPLOAD_DIR` 附件目录，并验证备份可恢复。
- 不要将 `.env`、备份文件或上传目录提交到版本控制。
