# e2e-inventory-ui —— 库存管理 UI 端到端测试

对**已部署的 dev 实例** `http://101.34.242.103:3000` 做库存管理（进销存 v3）的浏览器端到端测试。

两条主线：
1. **流程贯通** —— 三级链路（供应链总部 → 市场 → 门店）能否在 UI 上真的从头走到尾
2. **交互合理性** —— 控件选型、校验、反馈、空态是否合理，产出 `UX-FINDINGS.md`

## 与另外三套测试的分工

| 套件 | 层级 | 库 | 本套件的区别 |
|---|---|---|---|
| `src/**/*.test.ts`（Vitest） | 单元 | 无 | — |
| `tests/e2e-actions/smoke-inventory-*.mjs` | Server Action | 本地 docker 一次性库 | 它测**业务规则**，看不见页面 |
| `tests/e2e-chains/link-*.spec.ts` | UI 跨页 | dev 共享库 | 它**没有任何 inventory spec** |
| **本套件** | **UI + DB 双向断言** | **dev 共享库** | 填的就是 UI 层这块空白 |

## 跑法

```bash
cd fengyu-admin

bun run test:e2e:inventory-ui                    # 全套 12 个 spec / 17 个 test
PW_HEADED=1 bun run test:e2e:inventory-ui        # 有头观察

# 单条
bunx playwright test --config=tests/e2e-inventory-ui/playwright.inventory.config.ts \
  tests/e2e-inventory-ui/inv-03-*.spec.ts

# 指向别的实例
ADMIN_BASE_URL=http://localhost:3000 bun run test:e2e:inventory-ui

# 取证探针（默认 skip，不进套件）：逐秒采样批次下拉的加载状态
INVT_PROBE=1 bunx playwright test --config=tests/e2e-inventory-ui/playwright.inventory.config.ts \
  tests/e2e-inventory-ui/inv-90-probe-lot-loading.spec.ts
```

**spec 清单**：`inv-00` ~ `inv-12` 共 13 个文件。`inv-00` ~ `inv-10` 与 `inv-12` 各 1 个 test（单测试函数内跑完整条场景），
`inv-11`（#189 主体自动选中）是 `test.describe` 下的 6 个 test —— 它原先带 `test.skip(INVT_189 !== '1')` 开关，
#189 部署到 dev 并实跑 6/6 通过后开关已删除，现随常规套件跑。
`inv-12`（#340）用市场库存财务（单市场）发起市场间调货，**破坏性**（与 INV-05 第 4 段同样把货永久搬进自贡凤御），前置同 INV-05。
`inv-90` 被 `testMatch` 收进来，但文件内 `test.skip(INVT_PROBE !== '1')` 使它默认跳过。

> 本机若开着代理，Playwright 可能报 `ERR_PROXY_CONNECTION_FAILED`。
> 前面加 `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy` 即可。

**spec 之间有状态依赖**，必须按编号顺序跑（config 已设 `workers: 1` / `fullyParallel: false`）。
单据号通过 `.last-inventory-context.json` 传递；单跑靠后的 spec 前，先至少跑过一次 INV-01/02。
例外：INV-11 只读页面、不读上下文，除 INV-00 的账号 seed 外无前置。

> ⚠️ INV-10 的报告**转述**上游 spec 写进上下文的判定（`inv01` / `inv05` / `inv06` / `inv07`），
> 没跑上游时它会如实输出一条 P2「未覆盖」而不是静默跳过。看到「未覆盖 / 证据过期」字样，
> 含义是「本轮无从判断该 issue 是否回归」，**不是**缺陷复现，也**不能**读成「P0 已清零」。

## 前置条件

| 项 | 说明 |
|---|---|
| 测试账号 | INV-00 自动 seed 5 个 `INVT-*` 账号（幂等；INVT-MK-02 为 #340 新增的自贡市场财务），密码见 `_helpers/env.ts` |
| 期初门禁 | INV-02 会把 `inventory_cutover_states` 置「已初始化」并**保持开启**（已获用户确认） |
| 基础档案 | INV-01 自建供应商与 SKU；dev 库库存域原本是空的 |
| psql | 断言直连 `101.34.242.103:5433/fengyu_wxapp`，需本机有 `psql` 且能连通 |

### 测试账号

| employee_id | 手机号 | 角色 | scope | 用途 |
|---|---|---|---|---|
| `INVT-ADM-01` | 19900001001 | admin | ORG-HQ | 主链路驱动（scope 不受限、价格档 all） |
| `INVT-SC-01` | 19900001002 | inventory_supply_chain_operator | ORG-HQ | 供应链侧 + 边界断言 |
| `INVT-MK-01` | 19900001003 | inventory_market_finance | 南昌凤御 | 市场侧 + 边界断言 |
| `INVT-ST-01` | 19900001004 | inventory_store_operator | 南昌万科店 | 仅用于断言其**无法**登录 admin |

每个账号只绑**一个**角色 + 一个 scope —— 多绑定会触发 `inventoryPriceScopeByTier()` 的跨绑定
fail-closed 分支（`src/lib/inventory/access.ts:87-117`），把价格档打成空集，让边界断言全部假阴性。

## ⚠️ 对既有约定的破例

`tests/e2e-actions/smoke-inventory-chain.mjs:24-26` 明文规定：库存链路**不允许在共享开发库留残留**，
一律用本地 docker 一次性库（因为 `inventory_movements` 有 `trg_inventory_movements_append_only`
触发器，禁 UPDATE/DELETE，且钉住 lots/docs/skus 的整张 FK 图）。

本套件按用户决定**破例直连 dev 库且不做清理** —— 测的就是那个部署实例。代价是不可逆：
产生的库存流水删不掉。缓解措施是所有测试数据统一带 `INVT` 前缀、手机号用独立号段
`199000010xx`（避开 e2e-actions 的 `19999088xxx` 与 staff 的 `19999099xxx`）。

跑本套件**不会**影响 `bun run test:e2e:inventory`（那套仍跑自己的一次性 docker 库）。

## 目录

```
_helpers/
  env.ts            BASE / psql / 账号常量 / 组织拓扑 / login / tryLogin / 上下文读写
  seed-accounts.ts  幂等建 5 个测试账号（pg 参数化，bcrypt hash 带 $ 不能走 psql -c）
  cutover.ts        期初门禁开/关
  ui.ts             定位与操作原语（每个函数的注释都对应一个踩过的坑）
  ux-audit.ts       交互合理性启发式规则 + 报告渲染
inv-00 ~ inv-12     场景 spec（13 个文件 / 18 个 test），见 BUSINESS-SCENARIOS.md
inv-90-probe-*      #129 取证探针（默认跳过，INVT_PROBE=1 启用）
BUSINESS-SCENARIOS.md  业务场景设计与断言矩阵
UX-FINDINGS.md         交互合理性报告（INV-10 自动生成）
```

## 写新 spec 时值得先读的几条经验

都写在 `_helpers/ui.ts` 的函数注释里，这里列标题：

1. **别用 `getByLabel`** —— 部分 label 里塞了整段说明文字导致 substring 歧义；供应商表单的 label 根本没包裹控件
2. **`selectOption({label})` 只认精确字符串**，不收正则；option 文本是拼出来的就用 `selectContaining`
3. **`locator.isVisible()` 是即时检查且不接受 timeout** —— 断言「稍后出现」一律用 `waitFor` / `expect().toBeVisible()`
4. **提交后要主动读 toast 文本**，不能只 `expect(getByText(/成功/))`：失败时 toast 是错误文案，等超时后它早消失了，截图里什么都看不到
5. **办理台卡片不能 exact 匹配** —— 带权限徽章的卡片 accessible name 是「审批门店退货 审批权限」
6. **提交按钮要限定在 `<form>` 内** —— 卡片也是 button，「创建采购订单」既是卡片标题又是提交按钮
7. **批次要按可用量挑**，不能取第一个（同一主体常有多个批次）
8. **文本断言要收紧到数据行** —— 拿 `main` 全文匹配会把筛选器下拉选项误判成数据

## 首轮实测缺陷的收敛情况（2026-09-13 发现 → 2026-09-21 复核）

⚠️ 这张表是**人工维护的历史台账**，不随代码状态自动更新；判读当前状态请看 `UX-FINDINGS.md`
（由 INV-10 每次跑时**整文件覆写**，且已全部改成「实测再报」—— 本轮没有可转述的实测判定时
它会输出一条 P2「未覆盖」，不会假装已复核）。

| 级别 | 问题 | 影响 | 状态 |
|---|---|---|---|
| P0 | 单据中心批次下拉永久卡在「加载库存批次...」 | 6 种需选来源批次的单据在后台**完全建不出来** | #129 **已修并已部署 dev**（2026-09-21 用 `inv-90` 探针取证：批次框约 1 秒解禁） |
| P0 | 员工购的员工下拉恒为空（递归 CTE 别名写错，5 处） | 市场员工购 / 供应链员工购**完全不可用** | #130 **已修并已部署 dev**（实测候选：市场 115 人 / 供应链 10 人） |
| P1 | 盘点单不记录账面数量（`stock_snapshot` 恒 NULL） | 盘点无法用于盈亏对账 | #131 已修（账面数按主体 + SKU 汇总写入；INV-10 转述 INV-06 判定） |
| P1 | SKU「供货商」是自由文本，与供应商档案无外键 | 档案形同虚设，无法按供应商统计 | #132 **已修并已部署 dev**（改下拉 + `supplier_id` 外键；INV-10 转述 INV-01 判定） |
| P1 | 业务错误被生产构建脱敏成英文占位或 digest 数字 | 用户不知道发生了什么 | #133 已合入 dev（INV-10 仍无条件登记此条，待补实测口径） |
| P1 | 建单失败用 `alert()`、审批备注用 `prompt()` | 原生弹窗无法校验必填、阻塞页面 | #134 已修（INV-10 改为按本轮 `page.on('dialog')` 计数再报） |

两条 P0 修复后，原先**受阻而无法在 UI 层验证**的业务规则已可正常覆盖：
§8.2 分院调货限同市场、§10.3 市场间调货归属派生、自采 SKU 禁跨市场、报损审批链、内部领用、
市场员工购与供应链员工购（此前只由 action 层 smoke 覆盖）。

### 被测实例的版本落差（跑之前务必先看）

本套件打的是**已部署的 dev 实例**，不是工作区代码。2026-09-21 该实例跑的是 `ab282a13`：
**含** #129 / #130 / #132，**不含** 本分支在途的 #190 / #191 / #194 / #200。
所以依赖在途改动的定位（如 #194 给行内控件补的 `aria-label`）在当前实例上跑不通，
是**版本落差**而非测试缺陷 —— 重跑前先确认实例已部署到对应 commit。

## 本套件覆盖不到的范围

1. **门店侧 UI** —— `inventory_store_operator.can_access_admin = false`（migration 0039），
   门店库存员登不进后台；门店业务只能由超管代跑。真实门店体验需走 staff 小程序。
2. **门店价格档（none）的金额遮蔽** —— 同上，需在 staff 侧覆盖。
3. **超管跑主链路会绕过 scope 校验** —— `isAdminScope()` 让 scope 返回 `null`。
   所以 scope 隔离由 INV-08 用专用角色单独覆盖，两者不可互相替代。
4. **dev 落后于 `test` 分支** —— `0df2f706`（提货出库可用量漏减已预留）只在 `test` 分支；
   若可用量相关断言异常，先比对该提交再判定是否新问题。
