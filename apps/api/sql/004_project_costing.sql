-- 项目用料成本核算
--
-- 设计要点：
-- 1. 批次采购成本（batches.total_cost）只保存入库时录入的值；事后补录/更正走
--    batch_cost_adjustments 追加表，历史行不更新、不删除。
-- 2. 币种汇率以“生效日期”为键做时间序列（currency_rates）：同一币种同一生效日期
--    只有一个版本，补录新日期的汇率不会覆盖历史日期。
-- 3. 成本凭证 material_cost_vouchers 只追加。同一业务事件（一次消耗或其撤销）的凭证
--    构成版本链：root_voucher_id 相同、version 递增；旧凭证只做受控状态流转
--    （ACTIVE→SUPERSEDED/REVERSED/CONFIRMED，CONFIRMED→SUPERSEDED 需显式重开），
--    金额、数量、汇率等业务字段永远不可修改，DELETE 被禁止。
-- 4. CONFIRMED 凭证视为已结转/报账，自动重算会跳过；只能通过显式“重开”产生新版本，
--    历史凭证不会被静默改写。

CREATE TYPE cost_voucher_status AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'REVERSED', 'CONFIRMED');

CREATE TABLE costing_settings (
  id boolean PRIMARY KEY DEFAULT true,
  base_currency char(3) NOT NULL DEFAULT 'CNY',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT costing_settings_singleton CHECK (id)
);
INSERT INTO costing_settings (id) VALUES (true);

CREATE TABLE currency_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  rate_to_base numeric(20,10) NOT NULL CHECK (rate_to_base > 0),
  effective_from date NOT NULL,
  note varchar(500),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- 同一币种同一生效日期只能有一个汇率版本；补录请使用新的生效日期。
CREATE UNIQUE INDEX currency_rates_currency_date_uq ON currency_rates(currency, effective_from);
CREATE INDEX currency_rates_currency_date_idx ON currency_rates(currency, effective_from DESC);

CREATE TABLE batch_cost_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES batches(id),
  -- 补录发生时该批次剩余库存数量（库存单位），作为追加采购费的分摊基数。
  remaining_quantity_at_entry numeric(18,6) NOT NULL CHECK (remaining_quantity_at_entry >= 0),
  -- 追加采购费（原币，可正可负用于更正，不允许 0）。
  amount numeric(18,2) NOT NULL CHECK (amount <> 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  effective_from date NOT NULL,
  reason varchar(1000) NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX batch_cost_adjustments_batch_idx ON batch_cost_adjustments(batch_id, effective_from);

CREATE TABLE material_cost_vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 版本链：同一 consumption 的首版凭证 id；首版写入时即 root_voucher_id = id。
  root_voucher_id uuid NOT NULL,
  supersedes_voucher_id uuid REFERENCES material_cost_vouchers(id),
  version integer NOT NULL CHECK (version >= 1),
  event_type varchar(20) NOT NULL CHECK (event_type IN ('CONSUMPTION', 'REVERSAL')),
  consumption_id uuid NOT NULL REFERENCES consumptions(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  batch_id uuid NOT NULL REFERENCES batches(id),
  status cost_voucher_status NOT NULL DEFAULT 'DRAFT',
  -- 数量快照（库存单位），取自消耗记录，生成后不随后续重算改变。
  used_quantity numeric(18,6) NOT NULL CHECK (used_quantity >= 0),
  waste_quantity numeric(18,6) NOT NULL CHECK (waste_quantity >= 0),
  total_quantity numeric(18,6) NOT NULL CHECK (total_quantity > 0),
  -- 计价依据快照
  batch_initial_quantity numeric(18,6) NOT NULL CHECK (batch_initial_quantity > 0),
  batch_remaining_before numeric(18,6) NOT NULL CHECK (batch_remaining_before >= 0),
  unit_cost_orig numeric(20,10) NOT NULL DEFAULT 0 CHECK (unit_cost_orig >= 0),
  used_cost_orig numeric(18,2) NOT NULL,
  waste_cost_orig numeric(18,2) NOT NULL,
  total_cost_orig numeric(18,2) NOT NULL,
  currency char(3),
  exchange_rate numeric(20,10),
  exchange_rate_date date,
  unit_cost_base numeric(20,10) NOT NULL DEFAULT 0 CHECK (unit_cost_base >= 0),
  used_cost_base numeric(18,2) NOT NULL,
  waste_cost_base numeric(18,2) NOT NULL,
  total_cost_base numeric(18,2) NOT NULL,
  base_currency char(3) NOT NULL,
  basis jsonb NOT NULL DEFAULT '{}'::jsonb,
  remark varchar(500),
  confirmed_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- CONSUMPTION 凭证金额非负；REVERSAL 凭证金额非正（红冲）。
  CHECK (
    (event_type = 'CONSUMPTION'
      AND used_cost_orig >= 0 AND waste_cost_orig >= 0 AND total_cost_orig >= 0
      AND used_cost_base >= 0 AND waste_cost_base >= 0 AND total_cost_base >= 0)
    OR
    (event_type = 'REVERSAL'
      AND used_cost_orig <= 0 AND waste_cost_orig <= 0 AND total_cost_orig <= 0
      AND used_cost_base <= 0 AND waste_cost_base <= 0 AND total_cost_base <= 0)
  )
);
-- 每个版本链只有一张“当前版本”（DRAFT/ACTIVE/CONFIRMED 互斥）。
CREATE UNIQUE INDEX cost_vouchers_current_uq
  ON material_cost_vouchers(root_voucher_id)
  WHERE status IN ('DRAFT', 'ACTIVE', 'CONFIRMED');
CREATE UNIQUE INDEX cost_vouchers_chain_version_uq
  ON material_cost_vouchers(root_voucher_id, version);
CREATE INDEX cost_vouchers_consumption_idx ON material_cost_vouchers(consumption_id);
CREATE INDEX cost_vouchers_project_idx ON material_cost_vouchers(project_id, created_at DESC);
CREATE INDEX cost_vouchers_batch_idx ON material_cost_vouchers(batch_id);
CREATE INDEX cost_vouchers_status_idx ON material_cost_vouchers(status);

-- 凭证表只追加保护：
-- * DELETE 一律禁止；
-- * UPDATE 只允许 status / confirmed_at 变化（状态机校验），金额、汇率、数量、依据等
--   业务字段一律不可变。
CREATE OR REPLACE FUNCTION material_cost_vouchers_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'material_cost_vouchers 是只追加凭证表，禁止删除'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.root_voucher_id IS DISTINCT FROM OLD.root_voucher_id
     OR NEW.supersedes_voucher_id IS DISTINCT FROM OLD.supersedes_voucher_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.consumption_id IS DISTINCT FROM OLD.consumption_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.used_quantity IS DISTINCT FROM OLD.used_quantity
     OR NEW.waste_quantity IS DISTINCT FROM OLD.waste_quantity
     OR NEW.total_quantity IS DISTINCT FROM OLD.total_quantity
     OR NEW.batch_initial_quantity IS DISTINCT FROM OLD.batch_initial_quantity
     OR NEW.batch_remaining_before IS DISTINCT FROM OLD.batch_remaining_before
     OR NEW.unit_cost_orig IS DISTINCT FROM OLD.unit_cost_orig
     OR NEW.used_cost_orig IS DISTINCT FROM OLD.used_cost_orig
     OR NEW.waste_cost_orig IS DISTINCT FROM OLD.waste_cost_orig
     OR NEW.total_cost_orig IS DISTINCT FROM OLD.total_cost_orig
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate
     OR NEW.exchange_rate_date IS DISTINCT FROM OLD.exchange_rate_date
     OR NEW.unit_cost_base IS DISTINCT FROM OLD.unit_cost_base
     OR NEW.used_cost_base IS DISTINCT FROM OLD.used_cost_base
     OR NEW.waste_cost_base IS DISTINCT FROM OLD.waste_cost_base
     OR NEW.total_cost_base IS DISTINCT FROM OLD.total_cost_base
     OR NEW.base_currency IS DISTINCT FROM OLD.base_currency
     OR NEW.basis IS DISTINCT FROM OLD.basis
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION '成本凭证业务字段不可修改，只能追加新版本'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 仅允许 status / confirmed_at / remark 变化（备注与确认元数据不是金额字段）。
  IF NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.confirmed_at IS NOT DISTINCT FROM OLD.confirmed_at
     AND NEW.remark IS NOT DISTINCT FROM OLD.remark THEN
    RETURN NEW;
  END IF;

  -- 受控状态机
  IF NOT (
    (OLD.status = 'DRAFT' AND NEW.status IN ('ACTIVE', 'SUPERSEDED', 'REVERSED'))
    OR (OLD.status = 'ACTIVE' AND NEW.status IN ('SUPERSEDED', 'REVERSED', 'CONFIRMED'))
    OR (OLD.status = 'CONFIRMED' AND NEW.status = 'SUPERSEDED')
  ) THEN
    RAISE EXCEPTION '成本凭证状态不能从 % 流转到 %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'CONFIRMED' AND NEW.confirmed_at IS NULL THEN
    RAISE EXCEPTION '确认凭证必须记录确认时间' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER material_cost_vouchers_guard_trigger
  BEFORE UPDATE OR DELETE ON material_cost_vouchers
  FOR EACH ROW EXECUTE FUNCTION material_cost_vouchers_guard();

CREATE TRIGGER costing_settings_updated_at BEFORE UPDATE ON costing_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
