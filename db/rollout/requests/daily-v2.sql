-- 候选 SQL：仅供隔离测试库验证，正式迁移由集中集成生成。
CREATE TABLE daily_operating_periods (
  id text PRIMARY KEY, name text NOT NULL, start_date date NOT NULL, end_date date NOT NULL,
  weeks jsonb NOT NULL, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_daily_period_dates CHECK(start_date<=end_date),
  CONSTRAINT chk_daily_period_weeks CHECK(jsonb_typeof(weeks)='array' AND jsonb_array_length(weeks)=4),
  CONSTRAINT chk_daily_period_version CHECK(version>0)
);
CREATE TABLE daily_operating_targets (
  period_id text NOT NULL REFERENCES daily_operating_periods(id), scope text NOT NULL, scope_id text NOT NULL,
  sales bigint NOT NULL, consumption bigint NOT NULL, penalty text NOT NULL DEFAULT '',
  month_confirmed boolean NOT NULL DEFAULT false, weeks jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(period_id,scope,scope_id),
  CONSTRAINT chk_daily_target_scope CHECK(scope IN ('personal','store','market')),
  CONSTRAINT chk_daily_target_amount CHECK(sales>0 AND consumption>0 AND sales<=9007199254740991 AND consumption<=9007199254740991),
  CONSTRAINT chk_daily_target_version CHECK(version>0)
);
CREATE TABLE daily_pk_classes (
  id text PRIMARY KEY, period_id text NOT NULL REFERENCES daily_operating_periods(id), name varchar(30) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_daily_pk_period_name ON daily_pk_classes(period_id,name);
CREATE UNIQUE INDEX uq_daily_pk_period_id ON daily_pk_classes(period_id,id);
CREATE TABLE daily_pk_stores (
  period_id text NOT NULL REFERENCES daily_operating_periods(id), store_id text NOT NULL REFERENCES stores(store_id),
  class_id text NOT NULL, legion text NOT NULL DEFAULT '', group_name text NOT NULL DEFAULT '', mentor_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(period_id,store_id), FOREIGN KEY(period_id,class_id) REFERENCES daily_pk_classes(period_id,id)
);
ALTER TABLE daily_reports
  ADD COLUMN mentor_employee_id varchar(30) REFERENCES staff_wechat_users(employee_id),
  ADD COLUMN peer_employee_id varchar(30) REFERENCES staff_wechat_users(employee_id),
  ADD COLUMN period_snapshot jsonb,
  ADD COLUMN metric_snapshot jsonb;
