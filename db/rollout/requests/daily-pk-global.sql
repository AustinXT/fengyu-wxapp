-- 独立日报测试库候选迁移；正式迁移待集中集成，不修改旧迁移或journal。
ALTER TABLE daily_pk_classes ADD COLUMN month_key varchar(7);
ALTER TABLE daily_pk_stores ADD COLUMN month_key varchar(7);
UPDATE daily_pk_classes c SET month_key=COALESCE(p.month_key,to_char(p.end_date,'YYYY-MM')) FROM daily_operating_periods p WHERE p.id=c.period_id;
UPDATE daily_pk_stores s SET month_key=c.month_key FROM daily_pk_classes c WHERE c.id=s.class_id AND c.period_id=s.period_id;
CREATE UNIQUE INDEX uq_daily_pk_month_name ON daily_pk_classes(month_key,name);
CREATE UNIQUE INDEX uq_daily_pk_month_id ON daily_pk_classes(month_key,id);
CREATE UNIQUE INDEX uq_daily_pk_month_store ON daily_pk_stores(month_key,store_id);
ALTER TABLE daily_pk_classes ADD CONSTRAINT chk_daily_pk_class_month CHECK(month_key IS NULL OR month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE daily_pk_stores ADD CONSTRAINT chk_daily_pk_store_month CHECK(month_key IS NULL OR month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE daily_pk_stores ADD CONSTRAINT daily_pk_stores_month_key_class_id_daily_pk_classes_month_key_id_fk FOREIGN KEY(month_key,class_id) REFERENCES daily_pk_classes(month_key,id);
