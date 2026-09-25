import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeAll } from 'vitest'

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
function moduleSegments(dist: string, file: string): string[] {
  const lines = dist.split('\n')
  const out: string[] = []
  let inside = false
  for (const line of lines) {
    if (/^\/\/ (src|node_modules|\.\.)\//.test(line)) {
      inside = line === `// ${file}`
      continue
    }
    if (inside) out.push(line.trim())
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
    pattern: /^(COALESCE\(SUM\(reg\.registered\), 0\) AS registered,|GROUP BY \$\{groupId\})$/,
    minLines: 2,
    uniqueLines: 2,
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
    label: '提成明细 · 平均提成点公式（#375）',
    file: 'src/actions/data-center/commission.ts',
    pattern: /^const averageRate = /,
    minLines: 1,
    uniqueLines: 1,
    exactCountsInModule: true,
  },
]

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
