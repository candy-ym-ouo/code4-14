-- 项目用料成本核算：本位币设置、汇率、批次采购费、成本凭证。
-- 除 cost_settings 外所有表均为 append-only，由触发器禁止 UPDATE/DELETE，
-- 历史凭证只能通过 cost_voucher_supersessions 显式作废，不能被静默改写。

CREATE TABLE cost_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency char(3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX cost_settings_singleton_uq ON cost_settings ((true));

CREATE TRIGGER cost_settings_updated_at BEFORE UPDATE ON cost_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE exchange_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  currency char(3) NOT NULL,
  rate_to_base numeric(18,8) NOT NULL CHECK (rate_to_base > 0),
  effective_on date NOT NULL,
  notes text,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX exchange_rates_currency_date_uq ON exchange_rates(currency, effective_on);
CREATE INDEX exchange_rates_lookup_idx ON exchange_rates(currency, effective_on DESC);

CREATE TABLE batch_cost_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES batches(id),
  fee_type varchar(40) NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount <> 0),
  currency char(3) NOT NULL,
  incurred_on date NOT NULL,
  notes text,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX batch_cost_adjustments_batch_idx ON batch_cost_adjustments(batch_id, incurred_on);

CREATE SEQUENCE cost_voucher_no_seq;

CREATE TABLE cost_vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_no varchar(24) NOT NULL UNIQUE,
  project_id uuid NOT NULL REFERENCES projects(id),
  base_currency char(3) NOT NULL,
  line_count integer NOT NULL CHECK (line_count >= 0),
  priced_line_count integer NOT NULL CHECK (priced_line_count >= 0),
  used_total numeric(18,2) NOT NULL,
  waste_total numeric(18,2) NOT NULL,
  grand_total numeric(18,2) NOT NULL,
  lines_hash char(64) NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cost_vouchers_project_idx ON cost_vouchers(project_id, created_at DESC);

CREATE TABLE cost_voucher_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id uuid NOT NULL REFERENCES cost_vouchers(id),
  line_no integer NOT NULL,
  consumption_id uuid NOT NULL REFERENCES consumptions(id),
  batch_id uuid NOT NULL REFERENCES batches(id),
  material_id uuid NOT NULL REFERENCES materials(id),
  used_quantity numeric(18,6) NOT NULL CHECK (used_quantity >= 0),
  waste_quantity numeric(18,6) NOT NULL CHECK (waste_quantity >= 0),
  stock_unit stock_unit NOT NULL,
  currency char(3),
  priced boolean NOT NULL,
  batch_total_cost_base numeric(18,2),
  unit_cost_base numeric(18,8),
  fx_rate numeric(18,8),
  used_cost_base numeric(18,2),
  waste_cost_base numeric(18,2),
  total_cost_base numeric(18,2),
  UNIQUE (voucher_id, line_no)
);
CREATE INDEX cost_voucher_lines_consumption_idx ON cost_voucher_lines(consumption_id);
CREATE INDEX cost_voucher_lines_batch_idx ON cost_voucher_lines(batch_id);

CREATE TABLE cost_voucher_supersessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  old_voucher_id uuid NOT NULL REFERENCES cost_vouchers(id),
  new_voucher_id uuid NOT NULL REFERENCES cost_vouchers(id),
  reason varchar(200) NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX cost_voucher_supersessions_old_uq ON cost_voucher_supersessions(old_voucher_id);
CREATE INDEX cost_voucher_supersessions_project_idx ON cost_voucher_supersessions(project_id, created_at DESC);

CREATE OR REPLACE FUNCTION reject_row_modification() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '成本核算记录（%）不可修改或删除，只能追加更正记录', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER exchange_rates_immutable BEFORE UPDATE OR DELETE ON exchange_rates
  FOR EACH ROW EXECUTE FUNCTION reject_row_modification();
CREATE TRIGGER batch_cost_adjustments_immutable BEFORE UPDATE OR DELETE ON batch_cost_adjustments
  FOR EACH ROW EXECUTE FUNCTION reject_row_modification();
CREATE TRIGGER cost_vouchers_immutable BEFORE UPDATE OR DELETE ON cost_vouchers
  FOR EACH ROW EXECUTE FUNCTION reject_row_modification();
CREATE TRIGGER cost_voucher_lines_immutable BEFORE UPDATE OR DELETE ON cost_voucher_lines
  FOR EACH ROW EXECUTE FUNCTION reject_row_modification();
CREATE TRIGGER cost_voucher_supersessions_immutable BEFORE UPDATE OR DELETE ON cost_voucher_supersessions
  FOR EACH ROW EXECUTE FUNCTION reject_row_modification();
