# 日报五项目标与 Web 经营进度

状态：待迁移集中集成。用户已批准实现及 dev 验收，不部署生产。

候选 SQL：daily-five-metrics.sql。schema：db/schema/daily-report.ts。
新增 visits/new_customers/projects 可空整数及 counts_month_confirmed；历史数据保持空值，既有 sales/consumption/month_confirmed/weeks 不回填、不解锁。
发布顺序：集中生成不可变正式迁移、私有空库及旧目标夹具验证、dev journal 核对与迁库、dailyApiDev 与 admin dev、开发版小程序。
目标写入需同时更新 cloud target 和 admin 独立副本，验证版本锁、历史金额锁定、缺值/零值、周余额、跨范围拒绝和统计去重。禁止代码先于迁库部署。

## 已有验证与依赖

前置：0062_daily_v2_operating_pk / PR #523 仍开放，合入 dev 前不生成下一条正式历史。
候选 SQL 已应用本机私有 PG；旧金额目标锁定、单独补充计数、旧两项请求保留周计数及五项周余额验证通过。云函数53项、后台口径/菜单/页面40项、目标和配置PG6项、小程序UI及两端类型检查通过。
独立评审探针受本机 OpenCode 缺失、DeepSeek 凭证缺失阻塞，未宣称评审完成。
详细实现与验证见 daily-report/five-metrics-implementation.md。共用 dev 未执行此候选，生产未动。
