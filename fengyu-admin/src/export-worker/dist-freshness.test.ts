import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeAll } from 'vitest'
import { compareModuleRuntime } from './dist-equivalence'

/**
 * dist/export-worker.mjs 新鲜度守护。
 *
 * ## 为什么需要这个文件
 *
 * `fengyu-admin/dist/export-worker.mjs` 是**提交进版本控制**的预构建产物，
 * 且 `package.json:16` 的 `export-worker` 脚本**直跑它**（不经 Docker 构建）：
 *
 * ```json
 * "export-worker": "node --conditions=react-server dist/export-worker.mjs"
 * ```
 *
 * `src/export-worker/registry.ts` 直接 `import { getEfficiencyBoard }` 等 action，
 * 所以改了 `src/actions/data-center/*.ts` 的 SQL 口径却不重建产物时，
 * **页面数字已更新、导出的 Excel 仍是旧口径**，且没有任何测试会红。
 *
 * 该坑已复发三次，每次都是评审阶段才被人工发现：
 *   - `7d695743` build(admin): 重建 export-worker 产物同步客量新口径 (#138)
 *   - `c88ed9bf` build(admin): 重建 export-worker 产物同步成交率新口径 (#284)
 *   - 本次 (#290) —— 员工榜入榜口径
 *   - #298 —— 客量板一次/二次客活按到店天数（sibling 审计发现）
 *
 * ## 设计：动态提取，不硬编码期望值
 *
 * 每个探针从**源文件**里按正则提取当前的口径指纹行，再断言它们逐字出现在产物中。
 * 源码改了谓词 → 提取到的是新谓词 → 产物里没有 → 红。
 * 因此改口径**不需要**回来改这个测试，只需要重建产物 —— 这正是我们要强制的动作。
 *
 * 实测 `bun build` 对 SQL 模板字符串原样保留（不压缩、不重排空白），故可直接 `includes`。
 *
 * ## 新增板块口径时
 *
 * 往 `PROBES` 加一条即可。挑选指纹的标准：该行是**口径的承重部分**（改它就改了数字），
 * 且在源文件里字面唯一或接近唯一。
 */

const ADMIN_ROOT = path.resolve(__dirname, '../..')
const DIST = path.join(ADMIN_ROOT, 'dist/export-worker.mjs')

const REBUILD_HINT =
  '\n\n→ 修复：在 fengyu-admin/ 下重建产物（命令与 docker/Dockerfile.admin:99-106 逐字一致）：\n' +
  "     bun build src/export-worker/index.ts --target=node --format=esm \\\n" +
  '       --outfile=dist/export-worker.mjs --external pg-native \\\n' +
  '       --external @opentelemetry/api --external server-only \\\n' +
  "       --define process.env.FENGYU_EXPORT_WORKER='\"1\"'\n" +
  '     node --conditions=react-server dist/export-worker.mjs --check   # 应输出 bundle verified\n' +
  '   ⚠ 重建时 **NODE_ENV 必须不设**（`env -u NODE_ENV bun build …`）。实测 bun 的输出随它变：\n' +
  '     未设 6636632 字节 / NODE_ENV=test 6622668 / NODE_ENV=production 6598292，三份互不相同。\n' +
  '     已提交的这份是「未设」那一档；Docker 构建阶段是 production（Dockerfile.admin:41），\n' +
  '     但它自己会重建，不读这份 —— 这份服务的是 package.json 的 `export-worker` 直跑路径。\n' +
  '   ⚠ **merge 冲突时绝不能手工/自动文本合并这个文件** —— 它是 bundle，文本合并出来的是\n' +
  '     一份谁都构建不出来的产物（#414 实测：git 自动合并得到 6643958 字节，正确的是 6647513，\n' +
  '     而当时全部指纹探针照绿）。一律 `git checkout --ours/--theirs` 任取一侧后**重建**。\n' +
  '   然后单独成一个 build(admin): 提交（照 7d695743 / c88ed9bf 先例）。'

interface Probe {
  label: string
  file: string
  /** 按**行**匹配（行已 trim）。匹配到的整行会被拿去产物里找 */
  pattern: RegExp
  /** 期望至少提取到几行 —— 防止正则失配导致「零条指纹全通过」的 fail-open */
  minLines: number
  /**
   * 期望恰好提取到几条**不同**的指纹（可选）。只看原始行数时，把某条公式改成文件里已有的另一条同形指纹，
   * 行数不变、去重后全在旧产物里，守护恒绿；给出精确的唯一数，这类「改成另一条已有表达式」也会红。
   */
  uniqueLines?: number
  /**
   * 在产物里**该源文件的模块区段内**逐条比对指纹出现次数（可选）。bun 在每个模块前写 `// <源文件路径>` 注释，
   * 据此切出区段；源码里出现两次的指纹（如两处同形的分配金额公式）删掉其中一处而不重建时，
   * 去重后的 includes 比对仍全绿，只有频次比对能发现。
   */
  exactCountsInModule?: boolean
  /**
   * 比 `exactCountsInModule` 更强：按 `pattern` 在源码与产物区段各自重新筛出整行，
   * 要求两侧**多重集逐字相等**（可选）。
   *
   * ⚠ 只适用于**指纹落在 SQL 模板串里**的探针 —— `bun build` 原样保留模板串，但会重排 JS
   * （`#375 平均提成点` 那条就是 JS 行，实测两侧不逐字相等，开了必误红）。
   * 开着它，「往产物那一行尾部追加 ` OR TRUE`」这类既保子串又保频次的改动才会红（codex round-8 P2）。
   */
  exactLinesInModule?: boolean
}

/**
 * 去掉 SQL 注释再比对 —— 否则把产物里的某行注释掉，**子串与出现次数都不变**，
 * `exactCountsInModule` 与 `missing` 双双照绿，而那行 SQL 实际已失效
 * （codex round-5 抓到 `--`，round-6 之后又用 `/* … *\/` 绕过一次）。
 * 这是全部探针共用的通病，不只 #414 那两条。
 *
 * ⚠ **这个函数本身是开放集合**：它只处理注释落在**同一行**的情况。
 * 真正兜底的是下面那条「产物模块区段里不得出现 `/*`」的闭集断言
 * —— 跨行块注释、嵌套块注释、把指纹包进 `/* *\/` 的各种变体都由它拦，
 * 不需要在这里逐个补写法（本项目在 #286/#287 上已经证明逐条禁写法必被绕过）。
 *
 * 两侧（源码 / 产物）都要过这一道，否则源码里带尾注释的指纹会在产物侧找不到而误红。
 */
function uncomment(line: string): string {
  let cut = line.length
  for (const marker of ['--', '/*']) {
    const i = line.indexOf(marker)
    if (i >= 0 && i < cut) cut = i
  }
  return line.slice(0, cut).trim()
}

/**
 * 产物中属于某源文件的所有模块区段（同一模块可能被拆成多段）。
 * 前提：模块头是 bun 写的行首 `// src/…` / `// node_modules/…` / `// ../…` 注释；被守护的源文件自己不要写这种行首注释
 * （会被误当模块头截断区段，表现为误红，方向是 fail-closed）。bun 升级改了注释格式时这里要跟着改。
 */
/** `keepIndent`：AST 规范化比对要保留原始行（模板字面量里的缩进是 SQL 原文的一部分） */
function moduleSegments(dist: string, file: string, keepIndent = false): string[] {
  const lines = dist.split('\n')
  const out: string[] = []
  let inside = false
  for (const line of lines) {
    if (/^\/\/ (src|node_modules|\.\.)\//.test(line)) {
      inside = line === `// ${file}`
      continue
    }
    if (inside) out.push(keepIndent ? line : line.trim())
  }
  return out
}

const PROBES: Probe[] = [
  {
    label: '人效板 · 员工排行榜入榜口径（#290）',
    file: 'src/actions/data-center/efficiency.ts',
    pattern: /^WHERE \(pe\.has_skills OR COALESCE\(/,
    minLines: 5,
  },
  {
    label: '人效板 · 员工榜排序「非零优先」（#290）',
    file: 'src/actions/data-center/efficiency.ts',
    // 排序同样是承重口径：改了不重建产物，页面与 Excel 的顺序及 assignRanks 名次会分裂
    pattern: /^ORDER BY \(COALESCE\([\s\S]*<> 0\) DESC,/,
    minLines: 5,
  },
  {
    label: '人效板 · 产能员工候选池 has_skills 标记（#290）',
    file: 'src/actions/data-center/efficiency.ts',
    pattern: /^\(COALESCE\(cardinality\(array_remove\(array_remove\(sw\.skills, ''\), NULL\)\), 0\) > 0\) AS has_skills$/,
    minLines: 1,
  },
  {
    label: '客量板 · 一次/二次客活按到店天数（#298，KPI + 明细两处）',
    file: 'src/actions/data-center/customer.ts',
    pattern: /COUNT\(DISTINCT vd\.visit_date\) AS days/,
    minLines: 2,
  },
  {
    // #414 的承重口径有两半：分子的会员守卫 + 达成率的分母列。旧探针只盯到店天数，
    // 只改这两半而不重建产物的话，页面已是新口径、导出的 Excel 仍是旧口径，且没有测试会红。
    label: '客量板 · 客活分子会员守卫 became_member_at（#414，分子分母同源的承重半边）',
    file: 'src/actions/data-center/customer.ts',
    // 明细用 ${end}、KPI 用 ${range.end}；(start::date - 1) 形态的 anchor 不匹配
    pattern: /^AND c\.became_member_at::date <= \$\{(range\.)?end\}$/,
    // ⚠ 必须是**当前实际条数**（customer.ts:95/236/483/561/575/591），不能图保险写小。
    // 写 5 的话，把其中一处改成 `${start}` 仍能提取到 5 行 → 探针照绿、产物过期无人知
    // （红检 R19 实测过这个 fail-open）。多一处同形写法会让它变 7 行，仍 >= 6，不误报。
    minLines: 6,
    // 6 行只有 2 种文本（`${range.end}` ×3 @95/236/483 + `${end}` ×3 @561/575/591）。默认的 includes 比对去重后只查这 2 种
    // 在不在产物里 —— 单独从产物里删掉 `visit_count` 那一处，另外几处仍在 ⇒ 照绿
    // （codex round-4 P2）。必须开频次比对：区间 2026-07-01~07-31、门店 A，
    // 1 人 7 月前入会未到店 + 2 人 7 月各到店 1 天但 8-01 才入会 ⇒ 正确 0/1，缺守卫的产物给 2/1 = 200%。
    uniqueLines: 2,
    exactCountsInModule: true,
    exactLinesInModule: true,
  },
  {
    // SQL 与比率之间还有一跳 **JS 结果映射**（`num(r.registered)`），它在模板反引号**之外**，
    // 整段模板逐字比对覆盖不到（codex round-15 P2）。构造：用 `num(r.registered) / 2` 的源码
    // 构建产物、再把源码改回正确版本但不重建 ⇒ 页面 6/10 = 60%、导出 6/5 = 120%。
    // 四列一起钉：分母被除以 2 和分子被乘 2 是同一类错误。
    label: '客量板 · 明细 SQL 结果映射（#414，分子分母四列）',
    file: 'src/actions/data-center/customer.ts',
    pattern: /^(registered|retained|visitOnce|visitTwice): num\(r\.(registered|retained|visit_once|visit_twice)\),$/,
    minLines: 4,
    uniqueLines: 4,
    exactCountsInModule: true,
    exactLinesInModule: true,
  },
  {
    label: '客量板 · 达成率分母 = registered（#414，两条比率都要钉）',
    file: 'src/actions/data-center/customer.ts',
    // ⚠ 只钉 visitOnceRate 的话，单独让产物里的 visitTwiceRate 回退成 ra.retained 仍全绿
    // （codex round-4 P2）：registered=10 / retained=4 / visit_twice=2 时，页面 20% 而 Excel 50%。
    pattern: /^visit(Once|Twice)Rate: ra \? safeDiv\(ra\.visit\1, ra\.registered\) : null,$/,
    minLines: 2,
    uniqueLines: 2,
    exactCountsInModule: true,
    // ⚠ 这是本文件唯一把 exactLinesInModule 用在 **JS 行**上的探针，与上面「只适用于 SQL 模板行」
    // 的规则看似矛盾（GLM round-12 P3-2）。依据是**实测**：当前 bun 版本对这两行逐字保留
    // （节点 129-131 的比对结果 2/2 完全相等），而 `#375 平均提成点` 那条 JS 行会被重排。
    // 构建配置若变（例如开 minify），这条会**误红**而不是静默错数 —— fail-closed，
    // 届时按提示重建产物仍红的话，把它降级成退化口径（去掉 exactLinesInModule）即可。
    exactLinesInModule: true,
  },
  {
    // 只钉 `safeDiv(..., ra.registered)` 不够：`registered` 是怎么算出来的在 SQL 里，
    // 单独把产物的投影改成 `COALESCE(SUM(reg.registered), 0) / 2 AS registered`，
    // 上面两条探针的文本与频次完全不变 ⇒ 页面 60%/40% 而导出 120%/80%（codex round-6 P2）。
    label: '客量板 · 达成率分母的 SQL 投影与归组（#414）',
    file: 'src/actions/data-center/customer.ts',
    // `SELECT … COUNT(*) AS registered` 是**分母怎么算出来的**那一行（codex round-14 P2）：
    // 不钉它的话，用「reg 改成 COUNT(*) / 2」的源码正常构建产物、再把源码改回正确版本但不重建，
    // 六条守卫及其位置、两条 safeDiv、外层 SUM 与 GROUP BY **全都没变** ⇒ 全绿，
    // 而页面 6/10 = 60%、导出 6/5 = 120%。
    pattern: /^(SELECT c\.bound_store_id AS store_id, COUNT\(\*\) AS registered|COALESCE\(SUM\(reg\.registered\), 0\) AS registered,|GROUP BY \$\{groupId\})$/,
    minLines: 3,
    uniqueLines: 3,
    exactCountsInModule: true,
    exactLinesInModule: true,
  },
  {
    label: '客量板 · 到店日事件集 (顾客, service_date) 去重（#298，visitDaysSql）',
    file: 'src/lib/data-center/visit-days.ts',
    pattern: /^SELECT DISTINCT so\.client_user_id, \$\{col\} AS visit_date$/,
    minLines: 1,
  },
  {
    label: '剩余卡项 · 寄存单只计已支付（#371）',
    file: 'src/lib/data-center/remaining-cards-query.ts',
    pattern: /^AND \(sale_orders\.sale_order_type <> '寄存单' OR sale_orders\.status = '已支付'\)$/,
    minLines: 1,
  },
  {
    label: '剩余卡项 · 格剩余 = 未过期卡行的已付未用（#371）',
    file: 'src/lib/data-center/remaining-cards-query.ts',
    pattern: /^COALESCE\(SUM\(s\.paid_unused\) FILTER \(WHERE NOT s\.expired\), 0\) AS remaining,$/,
    minLines: 1,
  },
  {
    label: '剩余卡项 / 持卡折抵 · 已退完守卫（#371，lib/card-entitlement.ts）',
    file: 'src/lib/card-entitlement.ts',
    pattern: /sop\.change_type = '退款' AND sop\.status = '已支付'/,
    minLines: 1,
  },
  {
    label: '剩余卡项 · 已付未用表达式（paidUnusedSessionsExpr）',
    file: 'src/lib/paid-sessions.ts',
    pattern: /^export const paidUnusedSessionsExpr = sql/,
    minLines: 1,
  },
  {
    label: '客量板 · 分桶最低档下界 / 经营人数改读会员门槛（#292）',
    file: 'src/actions/data-center/customer.ts',
    // 4 行：KPI 的 `AS v`、明细 bucket_d / bucket_c / operated_total（含 `<` 与 `>=` 两种比较）
    pattern: /FILTER \(WHERE spend (<|>=) \$\{threshold\}/,
    minLines: 4,
  },
  {
    label: '客量板 · 分桶固定档位取 SPEND_BUCKET_FLOORS（#292）',
    file: 'src/actions/data-center/customer.ts',
    pattern: /\$\{floors\.(star|pink|gold|black)\}\) AS bucket_/,
    minLines: 5,
  },
  {
    // bun build 会重排 JS 代码、只原样保留模板字符串，所以探针只能取 SQL 行。主表 SQL 进了产物，
    // 就说明引用它的 registry 报表分发、technician-sql 人池参数是同一次构建带进去的
    label: '经营数据主表 · 门店骨架与行序（#372）',
    file: 'src/actions/data-center/operating-master.ts',
    pattern: /^(JOIN org_nodes mkt ON mkt\.id = sk\.market_id|ORDER BY mkt\.sort_order ASC NULLS LAST, sk\.market_name ASC, sk\.market_id ASC,)$/,
    minLines: 2,
  },
  {
    label: '经营数据主表 · 被经营门槛 / 回店≥2 天 / 售前按体验项（#373）',
    file: 'src/actions/data-center/operating-master.ts',
    pattern: /^(COUNT\(\*\) FILTER \(WHERE t\.month_amount >= \$\{threshold\}\) AS month_v|COUNT\(\*\) FILTER \(WHERE mv\.days >= 2\) AS twice|AND si\.is_experience = TRUE)$/,
    minLines: 3,
  },
  {
    label: '日常数据一览表 · 子项拆分缩放（#369）',
    file: 'src/lib/data-center/daily-overview-sql.ts',
    pattern: /^SUM\(rc\.amount \* pay\.amount \/ rc\.denominator\)::text AS amount$/,
    minLines: 1,
  },
  {
    label: '日常数据一览表 · 业绩 / 充值 / 服务的单据类型与状态口径（#369）',
    file: 'src/lib/data-center/daily-overview-sql.ts',
    pattern: /^AND (spe\.sale_order_type (IN|=) |so\.status = )/,
    minLines: 5,
  },
  {
    label: '频率表 · 到店日并入支付日，按 paid_at 上海日界（#370，visitDaysSql service_or_payment）',
    file: 'src/lib/data-center/visit-days.ts',
    pattern: /^AND \$\{PAYMENT_VISIT_DAY\} BETWEEN \$\{range\.start\} AND \$\{range\.end\}$/,
    minLines: 1,
  },
  {
    // 消耗那一行含 excludeDepositRefundSql('so')，bun 会把单引号改写成双引号，逐字比对必失配；取同一 CTE 的相邻行
    label: '频率表 · 当日消耗 / 服务项目按 (顾客, service_date) 聚合（#370）',
    file: 'src/lib/data-center/customer-frequency-query.ts',
    pattern: /^array_agg\(DISTINCT si\.product_name\) AS items$/,
    minLines: 1,
  },
  {
    label: '频率表 · 交易跟着顾客走：款项 / 服务按顾客归属过滤（#370）',
    file: 'src/lib/data-center/customer-frequency-query.ts',
    pattern: /^AND so\.client_user_id IN \(SELECT user_id FROM cust\)$/,
    minLines: 2,
  },
  {
    label: '员工提成日报 / 明细 · 取数条件与分配金额算法（#375）',
    file: 'src/lib/data-center/commission-sql.ts',
    // 按「列名」抓整行、不限取值：取值被改的行照样被提取出来，再去产物里逐字比对（只按取值抓会让改过的行
    // 直接脱离探针，守护恒绿）。排除带 ${…} 的行：bun 打包可能给模板里的局部变量改名，那种行在产物里不一定逐字存在。
    pattern: /^(?!.*\$\{)(AND (spia|sc|so|spe)\.(is_void|sale_order_type|status) .*|HAVING .*|ROUND\(ROUND\(.* AS allocated,)$/,
    minLines: 10,
    uniqueLines: 8,
    exactCountsInModule: true,
  },
  {
    label: '提成日报 / 明细 · 聚合与计数口径（实收按 receipt 去重、各项合计、条数 / 去重单数 / 去重人数）（#375）',
    file: 'src/lib/data-center/commission-sql.ts',
    // 聚合行整行比对：改公式（或删掉某个聚合列）后当前行不在旧产物里即红
    pattern: /^(?!.*\$\{)((SELECT )?\(?(SELECT )?COUNT\(.*|COALESCE\(SUM\(.*|\(SELECT COALESCE\(SUM\(r\.received\), 0\)|FROM \(SELECT DISTINCT receipt_id, received FROM summary_rows WHERE receipt_id IS NOT NULL\) r\) AS received,)$/,
    minLines: 15,
    uniqueLines: 15,
    exactCountsInModule: true,
  },
  {
    label: '提货 GCK 明细批次价格快照列（#341，锁批次 SELECT + 明细 INSERT 各一组）',
    file: 'src/actions/pickup-records.ts',
    // 只取多列组合行：单列 `store_actual_unit_price` 也出现在 TS 类型声明里，按「包含」计数会失真
    pattern: /^(lot\.)?(supply_chain_unit_cost, |market_actual_unit_price, )/,
    minLines: 4,
    uniqueLines: 4,
    exactCountsInModule: true,
  },
  // #360 进出明细的 SQL 不走本表的逐行探针：模板插值 `${filters.x}` / `${bound.after}` 里的局部变量
  // 会被 bun 合法改名，逐行文本比对必误红；改由下方「进出明细导出接线（#360）」里的语义等价比较（dist-equivalence.ts）整体守护。
  {
    label: '提成明细 · 平均提成点公式（#375）',
    file: 'src/actions/data-center/commission.ts',
    pattern: /^const averageRate = /,
    minLines: 1,
    uniqueLines: 1,
    exactCountsInModule: true,
  },
]

/**
 * #341 提货记录导出的 JS 接线（类型登记 / registry 分支与列 / action keyset 与金额投影）。
 * bun 会重写 JS（单引号→双引号、import 别名），所以这里按**产物里的写法**在对应模块区段内找固定片段；
 * 区段限定避免别处残留同名字面量造成假绿。改了这些源码记得重建产物并同步片段。
 */
describe('dist/export-worker.mjs 新鲜度 · 提货记录导出接线（#341）', () => {
  const SEGMENT_FRAGMENTS: Array<[string, string[]]> = [
    ['src/lib/export-job-types.ts', ['"pickup-records",', '"pickup-records": ["pickup_record:list"],', '"pickup-records": "提货记录",']],
    ['src/export-worker/registry.ts', [
      'case "pickup-records":',
      'sheetName: "提货记录",',
      '{ header: "顾客实际单价", width: 14, key: "pickupUnitPrice", map: (row) => numberOrEmpty(row, "pickupUnitPrice") },',
      '{ header: "出库金额", width: 14, key: "pickupAmount", map: (row) => numberOrEmpty(row, "pickupAmount") }',
    ]],
    ['src/actions/pickup-records.ts', [
      'var exportPickupRecords = withPermission("pickup_record:list",',
      'lt(pickupRecords.id, cursor)]);',
      'pickupUnitPrice: pickupRecords.pickupUnitPrice,',
      'pickupAmount: pickupRecords.pickupAmount,',
    ]],
  ]
  it.each(SEGMENT_FRAGMENTS)('%s 的 #341 片段在产物模块区段内', (file, fragments) => {
    const segment = moduleSegments(fs.readFileSync(DIST, 'utf-8'), file).join('\n')
    expect(segment.length, `产物里找不到 // ${file} 模块区段${REBUILD_HINT}`).toBeGreaterThan(0)
    const missing = fragments.filter((fragment) => !segment.includes(fragment))
    expect(missing, `产物 // ${file} 区段缺少以下 #341 片段（产物不是按当前源码构建的）${REBUILD_HINT}`).toEqual([])
  })
})

/** #360 进出明细导出的 JS 接线（类型登记 / registry 分支与列 / keyset 游标）。写法同上：按产物里的写法找。 */
describe('dist/export-worker.mjs 新鲜度 · 进出明细导出接线（#360）', () => {
  /**
   * 源码模块 ↔ 产物里 bun 改写后的同一模块做**语义等价**比较（规则与正反例见 dist-equivalence.ts / .test.ts）。
   * 比的是模块的全部运行时顶层语句：常量、入参校验、SQL 构造、行映射、取数、导出、withPermission 包装器。
   * ⚠ 误红时的排查顺序：先核对 bun 版本并按提示重建；重建后仍红，再看是不是出现了比较器没登记的新改写形态。
   */
  const resolveImportFile = (fromFile: string, specifier: string): string | null => {
    let base: string
    if (specifier.startsWith('@/')) base = `src/${specifier.slice(2)}`
    else if (specifier.startsWith('@db/')) base = `../db/schema/${specifier.slice(4)}`
    else if (specifier.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier))
    else return null
    for (const suffix of ['.ts', '.tsx', '/index.ts']) {
      if (fs.existsSync(path.join(ADMIN_ROOT, `${base}${suffix}`))) return `${base}${suffix}`
    }
    return null
  }
  const equivalenceIssues = (file: string, only?: readonly string[]) => {
    const dist = fs.readFileSync(DIST, 'utf-8')
    const segment = (target: string) => moduleSegments(dist, target, true).join('\n')
    return compareModuleRuntime({
      sourceCode: fs.readFileSync(path.join(ADMIN_ROOT, file), 'utf-8'),
      distCode: segment(file),
      distSegmentOfImport: (specifier) => {
        const target = resolveImportFile(file, specifier)
        if (!target) return null
        // 找不到模块头 / 区段为空都返回 null，交给比较器按「找不到区段」fail-closed
        const lines = moduleSegments(dist, target, true)
        return lines.some((line) => line.trim() !== '') ? lines.join('\n') : null
      },
      only,
    })
  }

  it.each([
    'src/lib/inventory/movements.ts',
    'src/actions/inventory/movements.ts',
  ])('%s 的全部运行时代码与产物语义等价', (file) => {
    expect(equivalenceIssues(file), `产物 // ${file} 区段与源码不等价（产物不是按当前源码构建的）${REBUILD_HINT}`).toEqual([])
  })

  it('export-job-types.ts 的类型登记、权限映射、标签映射与产物语义等价（键值对应关系整体比较）', () => {
    const file = 'src/lib/export-job-types.ts'
    expect(
      equivalenceIssues(file, ['EXPORT_JOB_TYPES', 'EXPORT_PERMISSIONS_BY_TYPE', 'EXPORT_LABEL_BY_TYPE']),
      `产物里的导出类型登记与源码不一致${REBUILD_HINT}`,
    ).toEqual([])
  })

  it('真实调用链：源码新增一个产物里根本没有的内部依赖（旧产物），必须判不等而不是当空模块放行', () => {
    const file = 'src/lib/inventory/movements.ts'
    const dist = fs.readFileSync(DIST, 'utf-8')
    // src/lib/menu.ts 不在 export-worker bundle 里：模拟「源码新增依赖、产物未重建」
    expect(moduleSegments(dist, 'src/lib/menu.ts', true)).toEqual([])
    const issues = compareModuleRuntime({
      sourceCode: `import '@/lib/menu'\n${fs.readFileSync(path.join(ADMIN_ROOT, file), 'utf-8')}`,
      distCode: moduleSegments(dist, file, true).join('\n'),
      distSegmentOfImport: (specifier) => {
        const target = resolveImportFile(file, specifier)
        if (!target) return null
        const lines = moduleSegments(dist, target, true)
        return lines.some((line) => line.trim() !== '') ? lines.join('\n') : null
      },
    })
    expect(issues.join('\n')).toMatch(/找不到 @\/lib\/menu 在产物里的模块区段/)
  })

  it('registry.ts 的 inventoryMovementColumns 与分发函数 createExportContent（含 case 分支体接线）与产物语义等价', () => {
    const file = 'src/export-worker/registry.ts'
    expect(
      equivalenceIssues(file, ['inventoryMovementColumns', 'createExportContent']),
      `产物里进出明细导出列与源码不一致（增删 / 换序 / 错接）${REBUILD_HINT}`,
    ).toEqual([])
  })

})

describe('dist/export-worker.mjs 新鲜度（改了 data-center SQL 口径必须重建产物）', () => {
  let dist: string

  beforeAll(() => {
    expect(
      fs.existsSync(DIST),
      `找不到 ${DIST} —— 该产物在版本控制内，不应缺失${REBUILD_HINT}`,
    ).toBe(true)
    dist = fs.readFileSync(DIST, 'utf-8')
  })

  it.each(PROBES.map((p) => [p.label, p] as const))(
    '%s 的口径指纹已同步进产物',
    (_label, probe) => {
      const src = fs.readFileSync(path.join(ADMIN_ROOT, probe.file), 'utf-8')
      const lines = src
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => probe.pattern.test(l))
        // 单行 sql`…` 模板（如 `export const x = sql<number>\`…\``）只取反引号内的模板正文：
        // 模板正文 bun build 原样保留，而声明部分会被改写（import 别名、去掉类型参数）
        .map((l) => /`([^`]*)`/.exec(l)?.[1] ?? l)

      // fail-closed：正则失配（比如源码重构后换了写法）不得静默通过
      expect(
        lines.length,
        `${probe.label}：在 ${probe.file} 里按 ${probe.pattern} 只提取到 ${lines.length} 行，` +
          `少于预期的 ${probe.minLines} 行。要么源码口径变了（请同步更新本探针的 pattern/minLines），` +
          '要么正则失配 —— 无论哪种，都不能让这条守护静默通过。',
      ).toBeGreaterThanOrEqual(probe.minLines)

      if (probe.uniqueLines !== undefined) {
        expect(
          new Set(lines).size,
          `${probe.label}：在 ${probe.file} 里提取到的不同指纹数与预期的 ${probe.uniqueLines} 条不符。` +
            '源码口径变了就同步更新本探针的 uniqueLines；若是把某条表达式改成了另一条已有的，这正是本断言要拦的。',
        ).toBe(probe.uniqueLines)
      }

      if (probe.exactCountsInModule) {
        const segment = moduleSegments(dist, probe.file)
        const srcLines = src.split('\n').map((l) => l.trim())
        expect(segment.length, `${probe.label}：产物里找不到 // ${probe.file} 模块区段${REBUILD_HINT}`).toBeGreaterThan(0)

        /**
         * 闭集兜底：`bun build` 会剥掉**全部** JS 注释，而被守护的这些源文件的 SQL 模板里
         * 一条块注释都没有 —— 实测 8 个探针文件的模块区段 `/*` 计数全为 0。
         * 所以「区段里出现了 `/*`」只有两种可能：产物被手改过，或源码 SQL 里新引入了块注释。
         * 两种都必须停下来看，不能让「把指纹包进 `/* … *\/`」这类变体一个个补正则去追
         * （codex round-7 P2；同族教训见 memory「守护别枚举开放集合，换闭集」）。
         * 真要在 SQL 里写块注释，就在这里放行并把该文件排除 —— 那是**有意识**的决定。
         */
        const blockComments = segment.filter((l) => l.includes('/*'))
        expect(
          blockComments,
          `${probe.label}：产物的 // ${probe.file} 模块区段里出现了块注释 \`/*\` —— ` +
            'bun build 会剥掉全部 JS 注释，这些源文件的 SQL 模板里也没有块注释，' +
            '所以这只能是产物被手改过（例如把口径指纹包进注释里让本守护假绿），或源码新引入了 SQL 块注释。\n' +
            blockComments.slice(0, 5).map((l) => `  · ${l}`).join('\n') +
            REBUILD_HINT,
        ).toEqual([])
        /**
         * 按 `probe.pattern` 在两侧各自筛出**整行**，比较**多重集等值**（排序后逐字相等）。
         *
         * ⚠ 这里**刻意不用 `includes` 子串匹配**（codex round-8 P2）：只要指纹仍是子串，
         * 往产物那一行尾部追加 ` OR TRUE` 就能让谓词失效而次数不变、也不含 `/*` ⇒ 全绿。
         * 本文件的 pattern 都是 `^…$` 锚定的整行正则，改成按 pattern 重新筛 + 逐字比对后，
         * 任何对该行的**增删改**都会让两侧多重集不等 —— 这是闭集，不再是「逐条禁写法」。
         * 实测三条 `exactCountsInModule` 探针两侧多重集完全相等（6/6、2/2、9/9）。
         */
        if (probe.exactLinesInModule) {
          const byPattern = (ls: string[]): string[] =>
            ls.map(uncomment).filter((l) => probe.pattern.test(l)).sort()
          const srcMatches = byPattern(srcLines)
          const distMatches = byPattern(segment)
          expect(
            distMatches,
            `${probe.label}：产物模块区段里按 ${probe.pattern} 筛出的行与源码不一致 ——\n` +
              `  源码 ${srcMatches.length} 行 / 产物 ${distMatches.length} 行。\n` +
              '产物不是按当前源码构建的，或该行在产物里被改动过（追加谓词 / 注释掉 / 删除）。' +
              REBUILD_HINT,
          ).toEqual(srcMatches)
        } else {
          // 退化口径（JS 行会被 bun 重排，只能按「包含」计频次）：拦得住删除与注释，
          // 拦不住「追加谓词」这类保子串的改动 —— 指纹在 SQL 模板里的探针一律开 exactLinesInModule
          const drift = [...new Set(lines)]
            .map((line) => ({
              line,
              src: srcLines.filter((l) => uncomment(l).includes(uncomment(line))).length,
              dist: segment.filter((l) => uncomment(l).includes(uncomment(line))).length,
            }))
            .filter((item) => item.src !== item.dist)
          expect(
            drift,
            `${probe.label}：以下指纹在源码与产物模块区段中的出现次数不一致 —— 产物不是按当前源码构建的：\n` +
              drift.map((d) => `  · 源码 ${d.src} 次 / 产物 ${d.dist} 次：${d.line}`).join('\n') +
              REBUILD_HINT,
          ).toEqual([])
        }
      }

      // 逐行比对（而不是对整份产物 `dist.includes`）：唯有按行才能剥掉 SQL 行注释，
      // 否则 `-- <指纹>` 里的子串照样命中整份文本 ⇒ 恒绿（codex round-5 P2）
      const distLines = dist.split('\n').map((l) => l.trim())
      const missing = [...new Set(lines)].filter(
        (line) => !distLines.some((l) => uncomment(l).includes(uncomment(line))),
      )
      expect(
        missing,
        `${probe.label}：以下口径指纹存在于 ${probe.file} 但**不在** dist/export-worker.mjs 中，` +
          `说明产物是改口径之前构建的 —— 导出的 Excel 仍会用旧口径，与页面数字对不上。\n` +
          missing.map((l) => `  · ${l}`).join('\n') +
          REBUILD_HINT,
      ).toEqual([])
    },
  )
})

/**
 * #292：导出进程（本产物）没有 Next incrementalCache，`unstable_cache` 一调就抛。
 * member-threshold.ts 为此加了直读分支；构建期 define 把 `process.env.FENGYU_EXPORT_WORKER === '1'`
 * 折叠成 `true`。源码行和产物行形态不同（类型被擦、判断被常量折叠），所以不走上面的逐行探针，单独断言。
 * 不重建产物的话，客量板 / 品项板导出全部失败（品项板在 prod 已 6/6 失败）。
 */
describe('dist/export-worker.mjs 会员门槛直读分支（#292）', () => {
  it('产物含 readMemberThreshold 直读函数，且导出进程分支已折叠为直读', () => {
    const dist = fs.readFileSync(DIST, 'utf-8')
    expect(dist, `产物缺 readMemberThreshold${REBUILD_HINT}`).toContain('async function readMemberThreshold(')
    const fn = dist.slice(dist.indexOf('async function getMemberThreshold('))
    expect(fn.slice(0, 200), `产物里 getMemberThreshold 没有先走直读${REBUILD_HINT}`).toMatch(
      /if \(true\)\s*return await readMemberThreshold\(\)/,
    )
  })
})

/**
 * #414：口径指纹的**位置**，不只是出现次数。
 *
 * 上面的逐行探针（连同 `exactLinesInModule` 的多重集逐字等值）比的是**行的集合**，
 * 丢掉了「这行在哪个 CTE 里」。于是一个由**另一个真实源码状态**构建出来的过期产物
 * —— 例如把会员守卫从 `visit_count` 挪进 `status_agg` —— 两侧多重集完全相同 ⇒ 全绿
 * （codex round-13 P2）。而那正是本文件要防的「产物没跟着源码重建」。
 *
 * 这里按 CTE 区间切片再断言，把位置也钉上。不做成通用 Probe 选项：目前只有达成率这条
 * 不变量对「谓词落在哪个 CTE」敏感（分子 ⊆ 分母全靠 `visit_count` 带着那条守卫）。
 */
describe('dist/export-worker.mjs 客活分子守卫的**位置**（#414）', () => {
  it('会员守卫落在 visit_count 段内，而不是被挪去别的 CTE', () => {
    const dist = fs.readFileSync(DIST, 'utf-8')
    const segment = moduleSegments(dist, 'src/actions/data-center/customer.ts').join('\n')
    expect(segment.length, `产物里找不到客量板模块区段${REBUILD_HINT}`).toBeGreaterThan(0)

    // ⚠ 起点**不能**用 `visit_count AS (` —— KPI 的 queryActive 里有个同名 CTE 且排在前面，
    // 切片会一路跨到明细的 `active AS (`，把仍带守卫的 reg / ret 段包进来 ⇒ 断言恒真。
    // 红检 R37 实测过这个假绿。用明细独有的投影行做锚，并断言它唯一。
    const NUM_ANCHOR = 'SELECT vd.client_user_id, c.bound_store_id AS store_id'
    expect(segment.split(NUM_ANCHOR), `产物里明细 visit_count 的锚点不唯一${REBUILD_HINT}`).toHaveLength(2)
    const from = segment.indexOf(NUM_ANCHOR)
    const to = segment.indexOf('active AS (', from + 1)
    expect(from, `产物里找不到明细 visit_count CTE${REBUILD_HINT}`).toBeGreaterThan(0)
    expect(to, `产物里 visit_count 之后找不到 active CTE${REBUILD_HINT}`).toBeGreaterThan(from)

    expect(
      segment.slice(from, to),
      '产物的 visit_count 段里没有会员守卫 —— 分子不再 ⊆ 分母，导出的达成率可 > 100%。' +
        '（行的总数可能仍对得上：守卫被挪进别的 CTE 时多重集不变）' +
        REBUILD_HINT,
    ).toContain('AND c.became_member_at::date <= ${end}')

    // 分母 reg 段同理：守卫在这里是「截至区间终点的会员」这个截面的定义
    const regFrom = segment.indexOf('reg AS (')
    const regTo = segment.indexOf('ret AS (', regFrom + 1)
    expect(regFrom).toBeGreaterThan(0)
    expect(regTo).toBeGreaterThan(regFrom)
    expect(segment.slice(regFrom, regTo), `产物的 reg 段里没有会员守卫${REBUILD_HINT}`).toContain(
      'AND c.became_member_at::date <= ${end}',
    )
  })
})

/**
 * #414：**整段 SQL 模板**逐字进入产物 —— 一次覆盖这份 SQL 的每一行。
 *
 * ## 为什么要这条
 *
 * 逐行探针是**开放集合**：每加一条口径行就得回来补一个 pattern，漏一行就有一条
 * 「源码正确、产物是另一个真实源码状态构建的」路径全绿。双谱系评审连着五轮
 * （r9 投影追加同名列 / r10-11 cron 与调用点 / r13 守卫位置 / r14 分母生产式）
 * 逐行指出缺口，就是这个形态。这里换**闭集**：把 `queryRegActiveBreakdown` 的整段模板
 * 拿去产物里找，任何一个字符的增删改都红，不需要预先知道哪行重要。
 *
 * ## 归一化：只抵消 bun 对**插值内部**做的两种改写，插值内容照比
 *
 * `bun build` 原样保留模板**正文**，只重写插值表达式内部：
 * ① JS 字符串 `'x'` → `"x"`　② 模块标识符前缀 `sql.raw(…)` → `import_drizzle_orm65.sql.raw(…)`。
 * 两侧只抵消这两种，**插值的其余内容逐字参与比对**。
 *
 * ⚠ 早先版本是把 `${…}` 整段遮成 `${}` —— 那样「用嵌套 `sql\`${customerScope} AND c.created_at::date <= ${start}\``
 * 替掉 `${customerScope}`」构建出来的过期产物会被整体遮掉而全绿（codex round-16 P2）。
 * 遮罩比抵消省事，但把要守的东西一起遮没了。
 *
 * ⚠ **SQL 正文里的引号一个都不碰** —— `'保有会员-稳定'` 的 `'` 与 `"` 在 PG 是
 * 字面量 vs 标识符，一起归一会放过真实的语义变化。
 */
describe('dist/export-worker.mjs 客量明细 SQL 整段逐字进入产物（#414）', () => {
  /**
   * 只在 `${…}` 插值区间内抵消 bun 的两种改写（JS 引号、`import_xxx.` 模块前缀），
   * 插值的其余内容原样保留参与比对。
   */
  const normalizeInterpolations = (text: string): string => {
    let out = ''
    for (let i = 0; i < text.length; ) {
      if (text.startsWith('${', i)) {
        let depth = 0
        let j = i
        for (; j < text.length; j++) {
          if (text[j] === '{') depth++
          else if (text[j] === '}' && --depth === 0) {
            j++
            break
          }
        }
        out += text
          .slice(i, j)
          .replace(/'/g, '"')
          .replace(/\bimport_[A-Za-z0-9_$]+\./g, '')
        i = j
      } else {
        out += text[i++]
      }
    }
    return out
  }

  it('queryRegActiveBreakdown 的整段模板在产物里逐字可找到', () => {
    const src = fs.readFileSync(path.join(ADMIN_ROOT, 'src/actions/data-center/customer.ts'), 'utf-8')
    const from = src.indexOf('WITH skel AS (${skeleton})')
    const to = src.indexOf('GROUP BY ${groupId}', from)
    expect(from, '源码里找不到明细 SQL 模板起点').toBeGreaterThan(0)
    expect(to, '源码里找不到明细 SQL 模板终点').toBeGreaterThan(from)
    const template = normalizeInterpolations(
      src.slice(from, to + 'GROUP BY ${groupId}'.length).replace(/\s+/g, ' ').trim(),
    )
    // fail-closed：模板短得离谱说明锚点漂了，不能让这条守护静默通过
    expect(template.length).toBeGreaterThan(2500)

    const dist = fs.readFileSync(DIST, 'utf-8')
    const segment = normalizeInterpolations(
      moduleSegments(dist, 'src/actions/data-center/customer.ts').join('\n').replace(/\s+/g, ' '),
    )
    expect(
      segment.includes(template),
      '产物里的客量明细 SQL 与当前源码**不逐字相同** —— 产物不是按当前源码构建的。' +
        '（逐行探针可能仍全绿：它们只看单行的集合，看不出整段结构）' +
        REBUILD_HINT,
    ).toBe(true)
  })
})

/**
 * ## 曾经试过、又撤掉的一条：`bun build` 重建后与已提交产物比对
 *
 * #414 期间加过一条「重建一次、比对自有 `// src/…` 模块段」的完整性兜底。
 * 它在本地**确实立过功**：merge dev 时 git 对本 bundle 做了文本自动合并，合出一份
 * **谁都构建不出来的产物**（6643958 字节 vs 正确的 6647513），而上面全部指纹探针照绿。
 *
 * **但它不可移植，已撤除**：CI（ubuntu + `npm ci` + bun latest）与本地（macOS + bun 1.3.3）
 * 重建出的产物里**全部 137 个源模块段都不相同** —— bun 版本与依赖安装方式都会改变 JS 变换结果
 * （标识符编号、格式），与口径无关。把它当 CI 闸门等于永久红。
 *
 * 所以守护回到「**源码文本 → 已提交产物**」这个方向，它对 bun 的 JS 变换免疫：
 * `bun build` 原样保留模板串，因此上面那条「整段 SQL 模板逐字进入产物」才是这一类的闭集，
 * 逐行指纹探针则负责给出「是哪条口径漂了」的诊断信息。
 *
 * ⚠ 想重新引入重建比对的话，先解决可移植性（锁定 bun 版本 + 统一安装方式），
 * 否则只是把一条守护换成一条噪音。手工排查时可直接跑 REBUILD_HINT 里的命令再 `cmp`。
 */
