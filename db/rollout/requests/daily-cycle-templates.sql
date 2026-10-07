CREATE TABLE daily_operating_period_templates (
  id text PRIMARY KEY,
  region_id text REFERENCES org_nodes(id) ON DELETE CASCADE,
  name varchar(60) NOT NULL,
  pattern jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_daily_period_template_global ON daily_operating_period_templates(name) WHERE region_id IS NULL;
CREATE UNIQUE INDEX uq_daily_period_template_region ON daily_operating_period_templates(region_id) WHERE region_id IS NOT NULL;

CREATE TABLE daily_operating_period_overrides (
  id text PRIMARY KEY,
  template_id text NOT NULL REFERENCES daily_operating_period_templates(id) ON DELETE CASCADE,
  region_id text REFERENCES org_nodes(id) ON DELETE CASCADE,
  month_key varchar(7) NOT NULL CHECK (month_key ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  pattern jsonb NOT NULL,
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_daily_period_override_global ON daily_operating_period_overrides(template_id, month_key) WHERE region_id IS NULL;

ALTER TABLE daily_operating_periods ADD COLUMN region_id text REFERENCES org_nodes(id);
ALTER TABLE daily_operating_periods ADD COLUMN month_key varchar(7);
ALTER TABLE daily_operating_periods ADD COLUMN template_id text;
ALTER TABLE daily_operating_periods ADD CONSTRAINT fk_daily_period_template FOREIGN KEY(template_id) REFERENCES daily_operating_period_templates(id) ON DELETE SET NULL;
ALTER TABLE daily_operating_periods ADD COLUMN template_source text NOT NULL DEFAULT 'legacy';
ALTER TABLE daily_operating_periods ADD CONSTRAINT chk_daily_period_month_key
  CHECK (month_key IS NULL OR month_key ~ '^\d{4}-(0[1-9]|1[0-2])$');
CREATE INDEX ix_daily_period_region_dates ON daily_operating_periods(region_id, start_date, end_date);
ALTER TABLE daily_operating_periods ADD CONSTRAINT chk_daily_period_template_source
  CHECK (template_source IN ('legacy','global-template','region-template','month-override','manual'));
CREATE UNIQUE INDEX uq_daily_period_region_month ON daily_operating_periods(region_id, month_key)
  WHERE region_id IS NOT NULL AND month_key IS NOT NULL;
CREATE UNIQUE INDEX uq_daily_period_global_month ON daily_operating_periods(month_key)
  WHERE region_id IS NULL AND month_key IS NOT NULL;

CREATE TABLE daily_operating_period_stores (
  period_id text NOT NULL REFERENCES daily_operating_periods(id) ON DELETE CASCADE,
  store_id text NOT NULL REFERENCES stores(store_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(period_id, store_id)
);
CREATE INDEX ix_daily_period_store_store ON daily_operating_period_stores(store_id, period_id);
