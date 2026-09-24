/**
 * 品项板块两端口径一致性守护（仿 dashboard.consistency.test.ts）
 *
 * 守护对象：
 *   - fengyu-admin/src/actions/data-center/product.ts                          (Drizzle / TS)
 *   - fengyu-staff/cloudfunctions/staffApi/routes/mgmt-product.js               (pg / JS)
 *
 * 两端 ORM 不同 + admin 额外支持二级品项(category_name)下钻 + byMarket/byStore 明细 →
 * 完整 SQL snapshot 不可行。守护策略 = "关键不变量字面量匹配"：
 *   1. 持卡 = paid_sessions > 0，不按 product_type 过滤
 *   2. 持卡 sale_order_type IN ('销售单','转换单','寄存单')
 *   3. cycle CTE 链：daily_agg / qualifying_days / repurchase_qualifying_days /
 *      first_entry / period_agg / xinzeng / fugou / tiyan
 *   4. 进入/复购达标日分别使用 day_received / purchase_received，并共用 threshold
 *   5. cycle 进入基线纳入寄存单；复购达标与区间业绩只统计销售单/转换单
 *   6. 业绩 = SUM(sale_item_performance_events.amount)（禁 paid_amount）
 *   7. 一级分组键 product_kind（admin 额外 category_name 二级，为 admin 独有扩展）
 *
 * 任一端一级口径变更必须双端同步，否则数据中心品项板块与员工端 mgmtProduct 数字对不上。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeAll } from 'vitest'

const ADMIN_PRODUCT = path.resolve(__dirname, '../product.ts')
const STAFF_MGMT_PRODUCT = path.resolve(
  __dirname,
  '../../../../../fengyu-staff/cloudfunctions/staffApi/routes/mgmt-product.js',
)

function normalize(src: string): string {
  return src.replace(/\s+/g, ' ').trim()
}

/** 剥离 JS/TS 注释（避免 docstring 里的反例引用干扰反向守护） */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

describe('品项板块两端口径一致性守护', () => {
  let adminSrc: string
  let staffSrc: string
  let adminCode: string // 剥注释后
  let staffCode: string

  beforeAll(() => {
    adminSrc = fs.readFileSync(ADMIN_PRODUCT, 'utf-8')
    staffSrc = fs.readFileSync(STAFF_MGMT_PRODUCT, 'utf-8')
    adminCode = normalize(stripComments(adminSrc))
    staffCode = normalize(stripComments(staffSrc))
  })

  describe('持卡 = paid_sessions > 0，不按 product_type 过滤（DISTINCT client）', () => {
    it('两端含 paid_sessions > 0', () => {
      expect(adminCode).toMatch(/paid_sessions\s*>\s*0/)
      expect(staffCode).toMatch(/paid_sessions\s*>\s*0/)
    })
    it('两端持卡查询不再按 product_type = 疗程卡过滤', () => {
      expect(adminCode).not.toMatch(/product_type\s*=\s*'疗程卡'/)
      expect(staffCode).not.toMatch(/product_type\s*=\s*'疗程卡'/)
    })
    it('两端持卡查询不再按 remaining_sessions > 0 过滤', () => {
      expect(adminCode).not.toMatch(/remaining_sessions\s*>\s*0/)
      expect(staffCode).not.toMatch(/remaining_sessions\s*>\s*0/)
    })
    it('两端禁用已废弃的 单品 字面量（product_type enum 已 3→2 值）', () => {
      expect(adminCode).not.toMatch(/'单品'/)
      expect(staffCode).not.toMatch(/'单品'/)
    })
    /**
     * ★★ **持卡占比的分子必须与分母同源**（#287）—— 这一组是本文件最重要的守护。
     *
     * ⚠️ **此处原本钉死的是错误写法**：旧断言要求两端都出现
     * `COUNT(DISTINCT so.client_user_id)`，而那正是缺陷本身 ——
     * 以 `sale_orders` 为驱动表数人，既不限客型（分子含非会员）、又按 `so.store_id` 归店
     * （与分母的 `c.bound_store_id` 不是一个键）。
     * 2026-09-22 审计实测：集团占比恒 **253%**、单店最高 **2600%**、40 家在营门店 36 家 > 100%，
     * 而这条守护全程绿灯 —— **守护钉住了错误口径，反倒让缺陷活得更久**。
     * 同型教训见 `notes/research/data-center-accuracy-audit-2026-09-22.md`。
     *
     * 现在改为钉「同源」这件事本身，分两个维度：
     *   ① **人群**：分子的驱动表是 `client_wechat_users` 且带 `became_member_at IS NOT NULL`
     *   ② **归店**：分子的 scope / 分组键是 `bound_store_id`，**不是** `so.store_id`
     *
     * 两端写法不同但同源性等价：admin 用「分母的壳 + `EXISTS`」，
     * staff 因分组键 `pc.product_kind` 在连接表上、写不进 `EXISTS`，改用
     * 「会员表驱动 + `COUNT(DISTINCT c.user_id)`」。所以这里按端分别断言，不做字面量对齐。
     */
    describe('持卡占比分子分母同源（#287）', () => {
      /** 切出 admin 某个查询函数的 **SQL 模板** */
      const adminCardSql = (fn: string): string => {
        const body = new RegExp(
          `async function ${fn}\\((?:[\\s\\S]*?)db\\.execute\\(sql\`([\\s\\S]*?)\`\\)`,
        ).exec(adminSrc)?.[1]
        return normalize(body ?? '')
      }
      /**
       * 切出 admin 某个查询函数的 **函数体**（含 `const sc = scopeFilterSql(...)` 那行）。
       *
       * ⚠️ scope 断言必须打在函数体上，**不能打在 SQL 模板上** —— 模板里只有 `${sc}`
       * 这个占位符，看不出 `sc` 是用哪一列构造的。本轮第一版就写成了
       * `toMatch(/scopeFilterSql\(…'c\.bound_store_id'\)|WHERE \$\{sc\}/)`，
       * 而 `WHERE ${sc}` 恒存在 ⇒ 整条断言**永远为真**（空断言），红检 R3 当场打出 GREEN。
       */
      const adminFnBody = (fn: string): string =>
        normalize(new RegExp(`async function ${fn}\\([\\s\\S]*?\\n}`).exec(adminSrc)?.[0] ?? '')

      /**
       * ★★★ **分子逐字等于「分母 + EXISTS 收窄」** —— 整组守护里最硬的一条。
       *
       * 前几版都是**字样守护**（检查 `FROM client_wechat_users` / `became_member_at` /
       * `EXISTS` 等片段是否出现），闸门 2 round-1 的 codex 连着打穿两种：
       *
       *   a) `WHERE ${sc}` 改成 `WHERE TRUE` —— `scopeFilterSql(...,'c.bound_store_id')`
       *      那行**仍在**（只是算出来没人用），四列集合仍为 1，全部断言照绿，
       *      而单店/市场分子已不受 scope 约束、可再次超过分母。
       *   b) 末尾追加 ` OR TRUE` —— 按 SQL 优先级整个 WHERE 恒真，
       *      分子不再受会员/scope/购买条件约束，但被匹配的字样一个不少。
       *
       * 与其逐条去堵（`OR` 禁令、`${sc}` 出现次数…），不如把「同源」这件事
       * **从字样升级成派生关系**：分子必须 === 分母**原文** + 一段 `EXISTS` 收窄。
       *
       * 于是：
       *   · 分母怎么改，分子必须一模一样地跟着改，否则红 —— 这正是 #287 要防的
       *     「一侧改了另一侧没改」
       *   · `WHERE TRUE` / `OR TRUE` / 任何外层 WHERE 的改动都会让等式不成立
       *   · 分子 ⊆ 分母 不再靠阅读理解，而是**逐字节可判定**
       */
      it('分子 === 分母 + EXISTS 收窄（逐字派生，不是两份独立快照）', () => {
        const EXISTS_CLAUSE =
          'AND EXISTS ( SELECT 1 FROM sale_items si ' +
          'JOIN sale_orders so ON so.sale_order_id = si.sale_order_id ' +
          'JOIN product_skus sk ON sk.sku_id = si.sku_id ' +
          'JOIN product_categories pc ON pc.category_id = sk.category_id ' +
          'WHERE so.client_user_id = c.user_id ' +
          'AND si.paid_sessions > 0 ' +
          "AND so.sale_order_type IN ('销售单', '转换单', '寄存单') " +
          "AND so.status = '已支付' " +
          'AND ${filter} )'

        // ① 全局：分子 = 分母 + EXISTS
        expect(
          adminCardSql('queryCardHolders'),
          '全局分子不再是「分母原文 + EXISTS 收窄」—— 分子分母已不同源（#287）',
        ).toBe(`${adminCardSql('queryMemberCount')} ${EXISTS_CLAUSE}`)

        // ② byStore：EXISTS 插在 GROUP BY 之前，其余逐字相同
        const denByStore = adminCardSql('queryMemberCountByStore')
        const cut = denByStore.lastIndexOf(' GROUP BY ')
        expect(cut, 'byStore 分母未按 GROUP BY 收尾 —— 切片口径需同步更新').toBeGreaterThan(0)
        expect(
          adminCardSql('queryCardHoldersByStore'),
          'byStore 分子不再是「分母原文 + EXISTS 收窄」—— 分子分母已不同源（#287）',
        ).toBe(
          `${denByStore.slice(0, cut)} ${EXISTS_CLAUSE}${denByStore.slice(cut)}`,
        )

        // ③ 分母自身不得退化：必须真的消费 ${sc}，不能只是「算了但没用」
        for (const fn of ['queryMemberCount', 'queryMemberCountByStore']) {
          expect(
            (adminCardSql(fn).match(/\$\{sc\}/g) ?? []).length,
            `${fn} 未恰好消费一次 \${sc} —— scopeFilterSql 算了却没用进 WHERE，scope 形同虚设`,
          ).toBe(1)
        }
      })

      it('admin 两个持卡查询都以「分母的壳 + EXISTS」为形状', () => {
        for (const fn of ['queryCardHolders', 'queryCardHoldersByStore']) {
          const s = adminCardSql(fn)
          expect(s, `${fn} 的 SQL 模板未切出`).toBeTruthy()
          // ① 人群同源：驱动表是会员表，且带会员条件
          expect(s, `${fn} 的驱动表不是 client_wechat_users —— 分子会含非会员`).toMatch(
            /FROM\s+client_wechat_users\s+c\b/,
          )
          expect(s, `${fn} 缺 became_member_at 条件 —— 分子人群与分母不同`).toMatch(
            /c\.became_member_at\s+IS\s+NOT\s+NULL/,
          )
          // ② 归店同源：scope 必须由 c.bound_store_id 构造（打在函数体上，不是模板上）
          const fnBody = adminFnBody(fn)
          expect(fnBody, `${fn} 的函数体未切出`).toBeTruthy()
          expect(
            fnBody,
            `${fn} 的 scope 不是用 c.bound_store_id 构造 —— 归店键与分母不同`,
          ).toMatch(/scopeFilterSql\(session,\s*scope,\s*'c\.bound_store_id'\)/)
          expect(fnBody, `${fn} 的 scope 仍用 so.store_id 构造`).not.toMatch(
            /scopeFilterSql\(session,\s*scope,\s*'so\.store_id'\)/,
          )
          // 结构：购买条件收在 EXISTS 里，而不是把 sale_orders 拉成驱动表
          expect(s, `${fn} 未用 EXISTS 收窄 —— 分子 ⊆ 分母 不再是结构性事实`).toMatch(
            /AND\s+EXISTS\s*\(/,
          )
          // 反向：绝不能回到以订单表数人的老写法
          expect(s, `${fn} 回到了 COUNT(DISTINCT so.client_user_id) —— #287 的缺陷原样复活`).not.toMatch(
            /COUNT\(DISTINCT\s+so\.client_user_id\)/,
          )
        }
      })

      /**
       * ★★ **守护必须是双边的** —— 上面那组只钉了**分子**。
       *
       * 只钉分子时，把**分母** `queryMemberCount` 的 scope 列改成 `'so.store_id'`，
       * 就能原样造回「分子按绑定门店、分母按订单门店」的 253% 同型缺陷，
       * 而 #287 的每一条断言**全绿** —— 正是本 PR 痛斥的那个失败模式，
       * 差点在同一个 PR 里重演一次。
       *
       * 所以这里不再各自硬编码字面量，而是断言**两侧的 scope 列相等**：
       * 一侧改了另一侧没改，必红。
       */
      it('分子与分母的 scope 列必须是同一个（两侧都不得单独改）', () => {
        const scopeColOf = (fn: string): string | undefined =>
          /scopeFilterSql\(session,\s*scope,\s*'([^']+)'\)/.exec(adminFnBody(fn))?.[1]

        const cols = {
          分子全局: scopeColOf('queryCardHolders'),
          分子按店: scopeColOf('queryCardHoldersByStore'),
          分母全局: scopeColOf('queryMemberCount'),
          分母按店: scopeColOf('queryMemberCountByStore'),
        }
        for (const [k, v] of Object.entries(cols)) {
          expect(v, `${k} 的 scopeFilterSql 调用未切出 —— 切片口径需同步更新`).toBeTruthy()
        }
        expect(
          new Set(Object.values(cols)).size,
          `持卡占比的四个查询用了不止一种 scope 列：${JSON.stringify(cols)} —— ` +
            '分子分母归店键不同正是 #287 的第二处根因（集团恒 253%、单店最高 2600%）',
        ).toBe(1)
        expect(cols.分母全局, 'scope 列不是 c.bound_store_id').toBe('c.bound_store_id')
      })

      it('admin byStore 的分组键与分母一致（都是 c.bound_store_id）', () => {
        expect(adminCardSql('queryCardHoldersByStore'), '持卡 byStore 未按 c.bound_store_id 分组').toMatch(
          /GROUP\s+BY\s+c\.bound_store_id\s*$/,
        )
        expect(adminCardSql('queryCardHoldersByStore'), '持卡 byStore 仍按 so.store_id 分组').not.toMatch(
          /GROUP\s+BY\s+so\.store_id/,
        )
        // 分母侧同键（改一侧没改另一侧时这条会红）
        expect(adminCardSql('queryMemberCountByStore'), '会员 byStore 未按 c.bound_store_id 分组').toMatch(
          /GROUP\s+BY\s+c\.bound_store_id\s*$/,
        )
      })

      it('staff 持卡 SQL 同源（会员表驱动 + buildClientScope）', () => {
        const card = normalize(/const cardSql = `([\s\S]*?)`/.exec(staffSrc)?.[1] ?? '')
        expect(card, 'staff cardSql 未切出').toBeTruthy()
        expect(card, 'staff 分子的驱动表不是 client_wechat_users —— 分子会含非会员').toMatch(
          /FROM\s+client_wechat_users\s+c\b/,
        )
        expect(card, 'staff 分子缺 became_member_at 条件').toMatch(
          /c\.became_member_at\s+IS\s+NOT\s+NULL/,
        )
        expect(card, 'staff 分子回到了以订单表数人的老写法').not.toMatch(
          /COUNT\(DISTINCT\s+so\.client_user_id\)/,
        )
        expect(card, 'staff 分子未按会员去重').toMatch(/COUNT\(DISTINCT\s+c\.user_id\)/)
        // 归店：必须走 buildClientScope（bound_store_id），不是 buildSaleScope（so.store_id）
        const holder = /持卡 SQL（占比分子）[\s\S]*?const cardSql = `/.exec(staffSrc)?.[0] ?? ''
        expect(holder, 'staff 持卡的 scope 仍用 buildSaleScope —— 归店键与分母不同').not.toMatch(
          /const\s+sc\s*=\s*buildSaleScope/,
        )
        expect(holder, 'staff 持卡未用 buildClientScope 构造 scope').toMatch(
          /const\s+cs\s*=\s*buildClientScope\(scopeType,\s*scopeId,\s*'c',\s*1\)/,
        )
      })

      /**
       * ★ **注释也要守** —— 本文件其余断言都跑在 `stripComments()` 之后，
       * 也就是说「注释里写着旧口径」这类漂移**结构性地测不到**。
       *
       * 本 PR 差点就留下这个：SQL 改对了，紧邻的函数 JSDoc / 文件头★红线却还写着
       * 「scope 用 `so.store_id`」，同一个文件里两套互相矛盾的口径自述。
       * 下一个人照 JSDoc 把代码改回去时，只有 SQL 断言拦得住，注释一路绿灯 ——
       * 而 memory `project-cross-end-copy-count-grows` 正记着「注释自述的口径不可信」。
       *
       * 所以这条**刻意跑在未剥注释的原文上**，禁掉已被推翻的旧口径字样。
       */
      it('两端的口径自述（含注释）不得残留旧的 so.store_id 归店说法', () => {
        for (const [name, src] of [
          ['admin product.ts', adminSrc],
          ['staff mgmt-product.js', staffSrc],
        ] as const) {
          const stale = src
            .split('\n')
            .filter((l) => /^\s*(\*|\/\/)/.test(l)) // 只看注释行
            .filter((l) => /so\.store_id/.test(l)) // 提到了订单店归店
            .filter((l) => /持卡|占比|分子|cardHolder/i.test(l)) // 且在持卡语境里
            // 放行两类**不是祈使句**的写法：
            //   a) 同一行也提到 bound_store_id —— 那是在对比两者（「分子按 A、分母按 B」）
            //   b) 带追述/否定词 —— 那是在讲历史或明确排除（「此前按…」「不是…」）
            .filter((l) => !/bound_store_id/.test(l))
            .filter((l) => !/此前|曾经|曾|原先|旧|不是|不得|禁|复活|回退/.test(l))
          expect(
            stale,
            `${name} 的注释里仍把持卡/占比的归店**祈使为** so.store_id —— ` +
              '与 #287 修正后的实现矛盾；照它改回去不会被其它断言拦住（其余断言都跑在 stripComments 之后）',
          ).toEqual([])
        }
      })

      it('staff 分子分母复用同一个 scope 构造（cs 只声明一次，两条查询都用它）', () => {
        /**
         * ⚠️ 第一版锚的是 `mgmtProductCycle` —— staffApi 里**没有这个函数**
         * （只有 `cardHolders` / `cycleStats`），正则永不匹配、每次都回落到
         * `?? staffSrc` 兜底全文件扫描。当前恰好全文件只有 1 处所以绿灯，
         * 但它守的不是「`cardHolders` 函数内只声明一次」：
         * `cycleStats` 将来也改走 `bound_store_id` 就会**误报红**，且报错信息指向错误的原因。
         * 「切不出就兜底到全文」本身就是空断言的温床（同 `82e3f1e7` 修掉的那条）。
         */
        const fnBody = /async function cardHolders\([\s\S]*?\n}/.exec(staffSrc)?.[0] ?? ''
        expect(fnBody, 'cardHolders 函数体未切出 —— 切片锚点需同步更新').toBeTruthy()
        /**
         * ⚠️ 数的是 **`buildClientScope(` 的调用次数**，不是 `const cs = …` 这个字面量 ——
         * 红检 R13 实测：写成 `const csDup = buildClientScope(...)` 换个变量名就能绕过
         * 按变量名计数的版本，而「两个 scope 对象同时存在」正是要防的东西。
         */
        expect(
          (fnBody.match(/buildClientScope\s*\(/g) ?? []).length,
          'cardHolders 里构造了不止一个 scope —— 分子分母各建一个，「归店键一致」会退化成靠自觉维护',
        ).toBe(1)
        expect(
          (fnBody.match(/buildSaleScope\s*\(/g) ?? []).length,
          'cardHolders 里出现 buildSaleScope —— 那是按 so.store_id 归店，正是 #287 的第二处根因',
        ).toBe(0)
        expect(
          staffSrc,
          '持卡查询仍在用 sc.params —— scope 参数与分母不同源',
        ).not.toMatch(/pg\.query\(cardSql,\s*sc\.params\)/)
        /**
         * ⚠️ 第一版只断言了 `pg.query(cardSql, cs.params)` —— 名字声称守**两条**查询，
         * 代码只守了一条（round-1 codex 找出的"第三条空断言"）。
         * 把 `pg.query(memberSql, [])` 写进去，断言照绿，而 market/store 档的
         * memberSql 含 `$1` 却没有绑定参数，运行时直接报错。
         */
        expect(staffSrc, '持卡查询未共用 cs.params').toMatch(/pg\.query\(cardSql,\s*cs\.params\)/)
        expect(staffSrc, '会员查询未共用 cs.params —— 与分子的 scope 参数脱钩').toMatch(
          /pg\.query\(memberSql,\s*cs\.params\)/,
        )
      })
    })
  })

  describe('持卡 sale_order_type IN (销售单, 转换单, 寄存单)', () => {
    it('admin', () => {
      expect(adminSrc).toMatch(
        /sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*,\s*'寄存单'\s*\)/,
      )
    })
    it('staff', () => {
      expect(staffSrc).toMatch(
        /sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*,\s*'寄存单'\s*\)/,
      )
    })
  })

  describe('cycle CTE 链一致（进入基线与复购达标分流）', () => {
    const ctes = [
      'daily_agg',
      'qualifying_days',
      'repurchase_qualifying_days',
      'first_entry',
      'period_agg',
      'xinzeng',
      'fugou',
      'tiyan',
    ]
    it('admin 含全部 8 个 CTE', () => {
      for (const c of ctes) expect(adminCode).toContain(c)
    })
    it('staff 含全部 8 个 CTE', () => {
      for (const c of ctes) expect(staffCode).toContain(c)
    })
  })

  describe('达标日 = day_received >= threshold（getMemberThreshold）', () => {
    it('admin daily_agg 用支付事件金额 + day_received >= threshold', () => {
      expect(adminCode).toMatch(/SUM\(sipe\.amount::numeric\)\s+AS\s+day_received/i)
      expect(adminCode).toMatch(/day_received\s*>=\s*\$\{threshold\}/)
    })
    it('staff daily_agg 用支付事件金额 + day_received >= $3(threshold)', () => {
      expect(staffCode).toMatch(/SUM\(sipe\.amount::numeric\)\s+AS\s+day_received/i)
      expect(staffCode).toMatch(/day_received\s*>=\s*\$3/)
    })
    it('两端经 getMemberThreshold 注入阈值', () => {
      expect(adminCode).toMatch(/getMemberThreshold/)
      expect(staffCode).toMatch(/getMemberThreshold/)
    })
  })

  describe('first_entry = 全历史最早达标日（跨店合并 MIN）', () => {
    it('admin', () => {
      expect(adminCode).toMatch(/MIN\(purchase_date\)\s+AS\s+entry_date/i)
    })
    it('staff', () => {
      expect(staffCode).toMatch(/MIN\(purchase_date\)\s+AS\s+entry_date/i)
    })
    it('两端 daily_agg 全历史下界（performance_date <= 区间末）', () => {
      expect(adminCode).toMatch(/FROM\s+sale_item_performance_events\s+sipe/)
      expect(adminCode).toMatch(/sipe\.performance_date\s*<=\s*\$\{range\.end\}/)
      expect(staffCode).toMatch(/FROM\s+sale_item_performance_events\s+sipe/)
      expect(staffCode).toMatch(/sipe\.performance_date\s*<=\s*\$2/)
    })
  })

  describe('cycle 进入基线纳入寄存单，复购事件仅限销售单/转换单', () => {
    it('admin', () => {
      expect(adminCode).toMatch(
        /daily_agg[\s\S]*?sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*,\s*'寄存单'\s*\)/,
      )
      expect(adminCode).toMatch(
        /FILTER\s*\(\s*WHERE\s+so\.sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*\)\s*\)[\s\S]*?AS\s+purchase_received/,
      )
      expect(adminCode).toMatch(
        /so\.status\s+NOT\s+IN\s*\(\s*'已关闭'\s*,\s*'已作废'\s*,\s*'未审核'\s*,\s*'待审批'\s*,\s*'支付失败'\s*\)/,
      )
    })
    it('staff', () => {
      expect(staffCode).toMatch(
        /daily_agg[\s\S]*?sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*,\s*'寄存单'\s*\)/,
      )
      expect(staffCode).toMatch(
        /FILTER\s*\(\s*WHERE\s+so\.sale_order_type\s+IN\s*\(\s*'销售单'\s*,\s*'转换单'\s*\)\s*\)[\s\S]*?AS\s+purchase_received/,
      )
      expect(staffCode).toMatch(
        /so\.status\s+NOT\s+IN\s*\(\s*'已关闭'\s*,\s*'已作废'\s*,\s*'未审核'\s*,\s*'待审批'\s*,\s*'支付失败'\s*\)/,
      )
    })
    it('两端 fugou 只读取 repurchase_qualifying_days，且区间业绩排除寄存金额', () => {
      for (const code of [adminCode, staffCode]) {
        expect(code).toMatch(/repurchase_qualifying_days\s+AS\s*\([\s\S]*?WHERE\s+purchase_received\s*>=/)
        expect(code).toMatch(
          /period_agg\s+AS\s*\([\s\S]*?purchase_received\s+AS\s+day_received[\s\S]*?purchase_received\s*>\s*0/,
        )
        expect(code).toMatch(/fugou\s+AS\s*\([\s\S]*?FROM\s+repurchase_qualifying_days\s+q/)
      }
    })
  })

  describe('复购 = 本期进入 cohort 在 entry_date 后区间内再次达标', () => {
    it('admin', () => {
      expect(adminCode).toMatch(/JOIN\s+xinzeng\s+x\s+ON\s+x\.client_user_id\s*=\s*q\.client_user_id\s+AND\s+x\.grp\s*=\s*q\.grp/)
      expect(adminCode).toMatch(/q\.purchase_date\s*>\s*x\.entry_date/)
    })
    it('staff', () => {
      expect(staffCode).toMatch(/JOIN\s+xinzeng\s+x\s+ON\s+x\.client_user_id\s*=\s*q\.client_user_id\s+AND\s+x\.product_kind\s*=\s*q\.product_kind/)
      expect(staffCode).toMatch(/q\.purchase_date\s*>\s*x\.entry_date/)
    })
  })

  /**
   * #286：明细「新增人数」的归店必须以 `xinzeng` 为主表 LEFT JOIN `period_agg`。
   *
   * 缺陷原理：`period_agg` 要求 `purchase_received > 0`（只统计销售单/转换单，**不含寄存单**），
   * 而进入达标（`first_entry` → `entry_store` → `xinzeng`）走 `day_received`（**含寄存单**）。
   * 以 `period_agg` 作主表再内连接回来，会把「进入达标日金额全部来自寄存单」的顾客整体丢弃 ——
   * 生产实测明细合计只有 KPI 的三分之一（**漏 65.5%**），派生的新增客单价与复购率双双虚高 **2.90 倍**。
   *
   * ⚠️ 这些断言只对**明细侧**（`queryCycleByStore`）的 SQL 模板生效：KPI 侧 `queryCycle`
   * 有一份同名 CTE 链，对整份源码 `toMatch` 时它的字面量会把明细侧的漏改顶掉。
   *
   * ⚠️ **所有断言都必须收进 `cteBlock()` 切出的 CTE 体内**。round-1 的三个 reviewer 各自
   * 实测出：只要正向断言的 `[\s\S]*?` 没有右边界，那个字面量出现在该 CTE 之后的任意位置
   * （别的 CTE 里、注释里、字符串里）都算数，于是多种改法能让 65.5% 的漏损 100% 复活而断言全绿。
   */
  describe('明细新增人数以 xinzeng 为主表归店（#286）', () => {
    /**
     * 单遍扫描剥掉 SQL 里的「噪音」，供结构断言使用。剥三类：
     *   1. **单引号字符串字面量**（含 `''` 转义）—— 堵「在块内塞一个
     *      `'FROM xinzeng x LEFT JOIN period_agg pa'` 字符串」的注入（round-1 GLM）
     *   2. **块注释 `/* *\/`，且按深度计数** —— PostgreSQL 的块注释**可嵌套**
     *   3. **行注释 `--`** —— 堵「删真实代码 + 用 `--` 把字面量补回去」
     *
     * ⚠️ **为什么不能用三条 `replace` 正则**（round-4 codex 实测打穿）：
     * `/\/\*[\s\S]*?\*\//` 只吃到**第一个** `*\/`，而 PG 允许嵌套。于是
     * `(/* outer /* inner *\/ still outer *\/SELECT 0)` 剥完剩下
     * `( still outer *\/SELECT 0)`，`\(\s*SELECT` 看不见这个子查询 ——
     * 把它乘进 `cnt` 就能让新增人数恒为 0，而块内全部断言仍绿。
     *
     * 单遍交替扫描同时保证了三者的嵌套顺序正确：先遇到 `'` 就整段吃字符串
     * （连同其中的 `--` / `/*`），先遇到注释就整段吃注释（连同其中的引号）。
     * 未闭合的 `/*` 会把剩余全部吞掉 → 切片失败 → 断言误红（fail-closed）。
     */
    const stripSqlNoise = (tpl: string): string => {
      let out = ''
      let i = 0
      let depth = 0
      while (i < tpl.length) {
        if (depth > 0) {
          if (tpl.startsWith('/*', i)) { depth++; i += 2; continue }
          if (tpl.startsWith('*/', i)) { depth--; i += 2; if (depth === 0) out += ' '; continue }
          i++
          continue
        }
        if (tpl.startsWith('/*', i)) { depth = 1; i += 2; continue }
        if (tpl.startsWith('--', i)) {
          while (i < tpl.length && tpl[i] !== '\n') i++
          out += ' '
          continue
        }
        if (tpl[i] === "'") {
          i++
          while (i < tpl.length) {
            if (tpl[i] === "'" && tpl[i + 1] === "'") { i += 2; continue }
            if (tpl[i] === "'") { i++; break }
            i++
          }
          out += ' '
          continue
        }
        out += tpl[i]
        i++
      }
      return out
    }

    /**
     * ★ 轻量 TS 词法扫描：切出 `queryCycleByStore` 的**真实函数体**，
     * 沿途剥掉 TS 注释，**字符串与模板字面量原样保留**。
     *
     * ⚠️ 为什么不能继续用正则 `/async function queryCycleByStore\([\s\S]*?\n}/`
     * （round-6 与 round-7 的 codex 连着打穿两次）：它把**第一个顶格 `}`** 当函数结尾，
     * 而顶格 `}` 可以来自函数内部的任何嵌套块 ——
     *
     *   async function queryCycleByStore(…) {
     *     if (false) {
     *       await db.execute(sql`<复制一份当前的安全模板>`)   ← 诱饵
     *   }                                                      ← 顶格，切片在此收尾
     *     const rows = await db.execute(sql`<已回退成内连接的真 SQL>`)
     *     …
     *   }
     *
     * 此时：诱饵被当成"真模板"、`db.execute` 计数仍是 1、全部快照都在检查诱饵，
     * 而 `if (false)` 运行时不执行，真正跑的是后面那条 —— 65.5% 漏数原样回归。
     * round-6 只堵住了"注释里的顶格 `}`"（先 `stripComments`），堵不住 `if` 块的。
     *
     * 不引 TypeScript AST（会把 `typescript` 拉进测试依赖），改用按花括号深度扫描：
     *   ① 括号深度跳过参数列表（参数可能有解构的 `{}`）
     *   ② 尖括号深度跳过返回类型注解（`Promise<Map<string, { … }>>` 里有 `{}`），
     *      函数体的 `{` 是尖括号深度为 0 时遇到的第一个
     *   ③ 花括号深度扫到函数体结尾，沿途跳过 `//` / `/* *\/` / `'…'` / `"…"` / `` `…` ``
     *      （模板字面量按 `${…}` 深度处理，不会被里面的 `}` 提前结束）
     *
     * 模板字面量原样保留是**故意的**：下面「禁 SQL 块注释」那条断言要检查真模板里有没有
     * `/*`。round-7 codex 指出上一版把它跑在 `stripComments` 之后的文本上，
     * 配对好的块注释在检查前就已经消失 —— **那条断言证明不了它声称的事**（空断言）。
     */
    const queryCycleByStoreBody = (src: string): string => {
      const decl = /async function queryCycleByStore\s*\(/.exec(src)
      if (!decl) return ''
      let i = decl.index + decl[0].length
      for (let paren = 1; i < src.length && paren > 0; i++) {
        if (src[i] === '(') paren++
        else if (src[i] === ')') paren--
      }
      let angle = 0
      while (i < src.length) {
        const c = src[i]
        if (c === '<') angle++
        else if (c === '>') angle = Math.max(0, angle - 1)
        else if (c === '{' && angle === 0) break
        i++
      }
      let out = ''
      let depth = 0
      while (i < src.length) {
        const c = src[i]
        if (c === '/' && src[i + 1] === '/') {
          while (i < src.length && src[i] !== '\n') i++
          out += ' '
          continue
        }
        if (c === '/' && src[i + 1] === '*') {
          i += 2
          while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
          i += 2
          out += ' '
          continue
        }
        if (c === "'" || c === '"') {
          const quote = c
          out += c
          i++
          while (i < src.length) {
            if (src[i] === '\\') {
              out += src.slice(i, i + 2)
              i += 2
              continue
            }
            out += src[i]
            i++
            if (src[i - 1] === quote) break
          }
          continue
        }
        if (c === '`') {
          out += c
          i++
          let tplDepth = 0
          while (i < src.length) {
            if (src[i] === '\\') {
              out += src.slice(i, i + 2)
              i += 2
              continue
            }
            if (src[i] === '$' && src[i + 1] === '{') {
              tplDepth++
              out += '${'
              i += 2
              continue
            }
            if (src[i] === '}' && tplDepth > 0) {
              tplDepth--
              out += '}'
              i++
              continue
            }
            if (src[i] === '`' && tplDepth === 0) {
              out += '`'
              i++
              break
            }
            out += src[i]
            i++
          }
          continue
        }
        if (c === '{') depth++
        else if (c === '}') {
          depth--
          out += c
          i++
          if (depth === 0) break
          continue
        }
        out += c
        i++
      }
      return out
    }

    /** 未经 SQL 清洗的模板原文 —— 「扫描器语法是超集」那组断言要用它。 */
    const detailTemplateRaw = (src: string): string =>
      /db\.execute\(sql`([\s\S]*?)`\)/.exec(queryCycleByStoreBody(src))?.[1] ?? ''

    /** 切出 queryCycleByStore 的 SQL 模板，避免 KPI 侧同名 CTE 链顶替。 */
    const detailSql = (src: string): string => normalize(stripSqlNoise(detailTemplateRaw(src)))
    /**
     * 切出单个 CTE 块（以下一个 CTE 名为右边界），避免跨块的惰性匹配假红/假绿。
     * 两侧都容忍 `AS MATERIALIZED (` 这种带物化提示的写法。
     */
    const cteBlock = (sqlText: string, name: string, nextName: string): string =>
      new RegExp(
        `${name}\\s+AS\\s+(?:MATERIALIZED\\s+)?\\(([\\s\\S]*?)\\),\\s*${nextName}\\s+AS\\s`,
      ).exec(sqlText)?.[1] ?? ''
    /** 末尾 CTE（store_ids）没有「下一个 CTE」，以最终 SELECT 为右边界 */
    const lastCteBlock = (sqlText: string, name: string): string =>
      new RegExp(`${name}\\s+AS\\s+(?:MATERIALIZED\\s+)?\\(([\\s\\S]*?)\\)\\s*SELECT\\s`).exec(sqlText)?.[1] ?? ''

    /**
     * 块内**禁止嵌套 CTE / LATERAL**（round-2 GLM）。
     *
     * `cteBlock` 以「`),` + 下一个 CTE 名 + ` AS `」为右边界。若块内自己嵌一个
     * `WITH decoy AS (...), repurchase_store AS (SELECT 1) SELECT ...` —— 撞名会让右边界
     * **提前闭合**，真正的坏代码落在切片之外，所有正向/反向断言都只检查到诱饵前缀。
     * 这四个聚合 CTE 本就不该嵌 CTE，一刀切禁掉（当前块内零 WITH，不误红）。
     */
    const assertNoNestedCte = (block: string, name: string): void => {
      expect(block, `${name} 块内出现嵌套 WITH —— 可用撞名 CTE 让切片右边界提前闭合`).not.toMatch(/\bWITH\b/i)
      expect(block, `${name} 块内出现 LATERAL —— 可借它注入零行子查询破坏结果`).not.toMatch(/\bLATERAL\b/i)
    }

    let adminDetail: string
    beforeAll(() => {
      adminDetail = detailSql(adminSrc)
    })

    /**
     * ★ 守护**守护自己**：`stripSqlNoise` 只认「普通单引号字符串（`''` 转义）」这一种字符串写法。
     * PostgreSQL 还有两种它不认识的，一旦被写进模板，扫描器与数据库对「哪段是字符串」
     * 的判断会**错位**（round-5 codex 提出 E-string 方向，美元引用是同类且更危险）：
     *
     *   1. `E'a\'b'` —— PG 认 `\'` 是转义引号、整体一个字符串；扫描器在那个引号处提前收尾，
     *      此后**相位翻转**：PG 在串内它在串外，或反过来。
     *   2. `$$ ... ' ... $$` / `$tag$ ... $tag$` —— PG 认整段是字符串；扫描器不懂美元引用，
     *      会把里面的 `'` 当成字符串开始，于是**把真实代码当字符串剥掉**。
     *      被剥掉的若正好是追加的过滤谓词，尾锚断言反而会通过 —— **假绿**。
     *
     * `new_store` 与最终 SELECT 钉的是字面快照（多一字少一字都红），相位错位对它们是 fail-closed；
     * 但 `entry_store` / `xinzeng` / `store_ids` 用的是带 `$` 尾锚的正则，**有被剥出假绿的可能**。
     *
     * 与其把扫描器写成完整的 PG 词法分析器，不如**把允许的写法收窄到扫描器的语法之内** ——
     * 让「扫描器认识的」成为「允许写的」的超集。当前模板这三样都是 0 处，不误红。
     */
    it('模板未使用扫描器不认识的字符串写法（否则剥离相位会与 PG 错位）', () => {
      const raw = detailTemplateRaw(adminSrc)
      expect(raw, '原始模板未切出').toBeTruthy()
      expect(raw, "模板出现 E'...' 转义字符串 —— stripSqlNoise 不认 \\' 转义，剥离相位会与 PG 错位").not.toMatch(
        /\bE'/i,
      )
      expect(raw, '模板出现美元引用字符串（$$ 或 $tag$）—— 扫描器会把其中的引号当字符串起点，可能把真实代码剥掉').not.toMatch(
        /\$\$|\$[A-Za-z_]\w*\$/,
      )
      expect(raw, '模板出现反斜杠 —— 只要没有 E 前缀 PG 就按字面处理，但这是 E-string 的前置条件，一并禁掉').not.toMatch(
        /\\/,
      )
      expect(
        (raw.match(/'/g) ?? []).length % 2,
        '模板里的单引号总数是奇数 —— 必有一处未闭合，扫描器之后的剥离全部失准',
      ).toBe(0)
      /**
       * round-6 codex：上面那条「禁美元引用」写成 `/\$[A-Za-z_]\w*\$/` 不够 ——
       * PG 的 dollar tag **允许非 ASCII 字母**（`$探针$ … $探针$` 合法），正则不命中；
       * 双引号标识符更可以容纳任意非零字符，而 `stripSqlNoise` 压根不认识它。
       * 两者都能把一整段**诱饵 CTE 链**伪装成常量列 / 长别名，让 `cteBlock()` 先切到诱饵，
       * 真正的 `new_store` 则可以恢复成内连接。继续沿「收窄语法」这条路一并禁掉。
       */
      expect(raw, '模板出现裸 $（非 ${...} 插值）—— PG 的 dollar tag 允许非 ASCII 标签，可藏整段诱饵 CTE 链').not.toMatch(
        /\$(?!\{)/,
      )
      expect(raw, '模板出现双引号 —— PG 的双引号标识符可容纳任意字符，扫描器不认识它，可藏整段诱饵 CTE 链').not.toMatch(
        /"/,
      )
      expect(raw, '模板出现 SQL 块注释 —— 会把「先剥 TS 注释」那一步带偏，两层剥离必须解耦').not.toMatch(
        /\/\*|\*\//,
      )
      expect(
        (adminSrc.match(/async function queryCycleByStore/g) ?? []).length,
        'queryCycleByStore 不止一处声明 —— 切片只取第一处，另一处可能才是真正执行的',
      ).toBe(1)
    })

    it('切片锚点有效（能切出明细侧 SQL 且含关键 CTE）', () => {
      expect(adminDetail, 'queryCycleByStore 的 SQL 模板未切出').toBeTruthy()
      for (const cte of ['entry_store', 'xinzeng', 'new_store', 'store_ids', 'period_agg']) {
        expect(adminDetail, `明细侧缺 ${cte} CTE`).toMatch(new RegExp(`${cte}\\s+AS\\s`))
      }
      // ⚠️ 必须用词法扫描出的真实函数体来数，不能再用正则切片 ——
      // 正则会在第一个顶格 `}` 处收尾，于是「诱饵 + 真 SQL」两条 db.execute 只数到 1。
      const body = queryCycleByStoreBody(adminSrc)
      expect(body, 'queryCycleByStore 函数体未切出').toBeTruthy()
      /**
       * ★ **通用截断探测** —— 不去追每一种能骗过词法扫描器的写法，直接检查
       * 切出来的函数体是不是**一路切到了真正的结尾**。
       *
       * round-6 / round-7 / round-8 的攻击本质完全相同：让切片提前收尾，
       * 使后面真正执行的 SQL 落在守护视野之外。载体换了三次 ——
       * 注释里的顶格 `}` → `if (false) {…}` 的顶格 `}` → 正则字面量 `/}/`
       * （最后这条是 round-8 DeepSeek 实测打穿的：扫描器不认正则字面量，
       * 把 `/}/` 里的 `}` 当成花括号，深度归零就 break）。
       *
       * 与其给扫描器补第四、第五个词法分支（正则 vs 除法要靠前一个 token 判别，
       * 本身就容易再错），不如锁住**结尾**：只要提前收尾，这条必红。
       * 它对所有「早收尾」类攻击同时生效，包括还没被想到的那些。
       */
      expect(
        body.trimEnd().endsWith('return m\n}'),
        'queryCycleByStore 函数体没切到真正的结尾 —— 切片被提前截断了，' +
          '后面可能藏着真正执行、却不受本组守护检查的 SQL',
      ).toBe(true)
      expect(body, '函数体缺少结果装配段 —— 同上，切片可能被截断').toMatch(/m\.set\(id,\s*\{/)
      expect(
        (body.match(/db\.execute\(/g) ?? []).length,
        '明细侧出现多个 db.execute —— 可能有一条是诱饵，也可能 detailSql 的切片口径需同步更新',
      ).toBe(1)
      /**
       * ★ 全局兜底：把**整份文件**的 `db.execute(` 条数钉死。
       *
       * 上面那条只在「切片正确」的前提下成立 —— 而前三轮的攻击恰恰都是**劫持切片**
       * （注释里的顶格 `}`、`if (false)` 块的顶格 `}`）。切片一旦被截短到只剩诱饵，
       * 块内计数就还是 1，照样绿。
       *
       * 这条不依赖切片：**在文件任何位置新增一条 `db.execute(` 都会红**，
       * 包括所有「加一条诱饵、让守护去检查它」的变形。
       *
       * ⚠️ 正常新增查询也会红 —— 那时请确认新查询不是明细侧归店链路，再把数字调上去。
       */
      expect(
        (adminSrc.match(/db\.execute\(/g) ?? []).length,
        'product.ts 的 db.execute 条数变了 —— 若是正常新增查询请确认它不在明细侧归店链路上，再同步本数字',
      ).toBe(8)
    })

    /**
     * ★★ **函数壳字面快照** —— 整组守护的最后一道，也是最硬的一道。
     *
     * 前面每一条守护都在回答「函数体内某处写法对不对」，于是评审一轮换一个姿势，
     * 让**守护检查的那段**与**数据库真正执行的那段**解耦。八轮下来的攻击谱系：
     *
     *   r6  注释里藏诱饵 `db.execute` + 独占行 `}`      → 切片提前收尾
     *   r7  `if (false) { … }` 的顶格 `}`                → 切片提前收尾
     *   r8  正则字面量 `/}/`（扫描器把 `}` 当花括号）     → 切片提前收尾
     *   r9  **不截断**：安全 SQL 放进一个从不调用的箭头函数（于是 `return m\n}` 结尾正常、
     *       正则先匹配到它），真正的调用改成 `db['execute'](…)` 计算属性 ——
     *       字面量 `db.execute(` 全文仍是 8，**上面两条与载体无关的守护同时失效**
     *
     * r9 说明「逐条补词法分支」这条路走不到头。换成钉死**整个函数壳**：
     * 取 `async function queryCycleByStore(` 到相邻唯一声明 `function buildMetrics(` 之间的全文，
     * 把 SQL 模板整段替换成占位符（模板本身由上面的 CTE 快照逐块守护），剥注释、压平空白，
     * 然后 `toBe` 全等。
     *
     * 于是**函数里多一行、少一行、换一种调用写法、插一个箭头函数，全部会红**，
     * 不再依赖「扫描器是否认得某种词法」。
     *
     * ⚠️ 这是字面快照：改动这个函数（哪怕只是重命名局部变量）都会红。
     * 看到红时请先确认**归店语义没变**，再把新快照同步进来 ——
     * 别反过来把断言改宽，那正是 `23405ddf` 让 #285 的缺陷活两个月的原因。
     */
    /**
     * ★ **生产调用点守护**（round-10 codex）。
     *
     * 上面那条把函数**定义**钉死了，却没锁住「这个函数是不是真的被用」。绕过路径：
     *   ① 安全版 `queryCycleByStore` 原封不动（函数壳快照、CTE 快照全绿）
     *   ② 在 `buildMetrics` 之后新增一个 `legacyCycleByStore`，恢复旧的内连接 SQL
     *      （用 `db['execute']` 或干脆放到别的文件，绕开 `db.execute(` 计数）
     *   ③ 把 `Promise.all` 里那一行改成调用 `legacyCycleByStore(…)`
     * 于是全部守护检查的都是一个**没人调用**的函数，明细重新漏 65.5%。
     *
     * 两条一起堵：调用点钉字面快照 + `queryCycleByStore(` 在剥注释后的源码里恰好两处
     * （一处声明、一处调用）。
     */
    it('queryCycleByStore 的生产调用点未被换掉', () => {
      const code = stripComments(adminSrc)
      expect(
        (code.match(/queryCycleByStore\(/g) ?? []).length,
        'queryCycleByStore 的出现次数不是「一处声明 + 一处调用」—— ' +
          '可能新增了旁路实现，也可能调用点被换成了别的函数',
      ).toBe(2)
      expect(
        normalize(code),
        '明细侧的生产调用点变了 —— 确认 Promise.all 第三项仍直接调 queryCycleByStore 且实参未变',
      ).toContain('queryCycleByStore(session, scope, cur, threshold, groupCol, filter),')
    })

    it('queryCycleByStore 的函数壳未变（除 SQL 模板外全等）', () => {
      expect(
        // ⚠️ 必须在**剥注释后**计数：注释里写一行 `// function buildMetrics(`
        // 就能把「声明唯一」这条伪造掉，从而挪动函数壳的右边界（round-10 codex）
        (stripComments(adminSrc).match(/function buildMetrics\(/g) ?? []).length,
        '右边界锚点 buildMetrics 不唯一 —— 函数壳切片口径需同步更新',
      ).toBe(1)
      const from = adminSrc.indexOf('async function queryCycleByStore(')
      const to = adminSrc.indexOf('function buildMetrics(')
      expect(from >= 0 && to > from, '函数壳切片锚点失效').toBe(true)
      // 先挖掉 SQL 模板再剥注释：模板内已禁块注释，两层剥离互不干扰
      const shell = normalize(
        stripComments(adminSrc.slice(from, to).replace(/sql`[\s\S]*?`/, 'sql`<TEMPLATE>`')),
      )
      expect(
        shell,
        'queryCycleByStore 的函数壳变了 —— 先确认归店语义没变（特别是 db.execute 的调用写法、' +
          '有没有多出未被调用的函数、结果装配有没有改），再同步本快照',
      ).toBe(
          "async function queryCycleByStore( session: AuthSession, scope: DataCenterScope, range: R" +
          "esolvedRange, threshold: number, groupCol: SQL, filter: SQL, ): Promise< Map< string, { " +
          "trialCount: number newCount: number newRevenue: number repurchaseCount: number repurchas" +
          "eRevenue: number } > > { const sc = scopeFilterSql(session, scope, 'so.store_id') const " +
          "rows = await db.execute(sql`<TEMPLATE>`) const m = new Map< string, { trialCount: number" +
          " newCount: number newRevenue: number repurchaseCount: number repurchaseRevenue: number }" +
          " >() for (const raw of rows as unknown[]) { const r = raw as Record<string, unknown> con" +
          "st id = String(r.store_id ?? '') if (!id) continue m.set(id, { trialCount: num(r.trial_c" +
          "ount), newCount: num(r.new_count), newRevenue: round2(r.new_revenue), repurchaseCount: n" +
          "um(r.repurchase_count), repurchaseRevenue: round2(r.repurchase_revenue), }) } return m }",
      )
    })

    /**
     * `entry_date` 与 `entry_store_id` 必须出自**同一行**（`DISTINCT ON`），而不是
     * 「先算 entry_date、再用等值条件回查门店」。两个理由都由 round-1 实测背书：
     *   1. **NULL 安全**：回查要用 `qd.grp = fe.grp`，而 `product_kind` 在 schema 里可空，
     *      grp 为 NULL 时等值不匹配 → `entry_store_id` 为 NULL → 那批人静默丢三次。
     *   2. **性能**：回查是相关子查询，O(|xinzeng| × |qualifying_days|)，
     *      生产实测把这条明细查询拖慢 **+177%**；DISTINCT ON 版与基线持平，结果双向 EXCEPT 为 0 行。
     */
    it('entry_store：entry_date 与 entry_store_id 出自同一行（DISTINCT ON，非等值回查）', () => {
      const block = cteBlock(adminDetail, 'entry_store', 'xinzeng')
      expect(block, 'entry_store CTE 未切出').toBeTruthy()
      assertNoNestedCte(block, 'entry_store')
      expect(block, '未用 DISTINCT ON (client_user_id, grp)').toMatch(
        /SELECT\s+DISTINCT\s+ON\s*\(\s*client_user_id,\s*grp\s*\)/,
      )
      expect(block, 'entry_date 与 entry_store_id 未出自同一行').toMatch(
        /purchase_date\s+AS\s+entry_date[\s\S]*?store_id\s+AS\s+entry_store_id/,
      )
      // 连续锚：`FROM qualifying_days` 与 `ORDER BY` 之间不许插任何东西 ——
      // 追加一条 `JOIN foo ON ...` 或 `WHERE grp IS NOT NULL` 就能把达标日来源筛掉一部分人，
      // 而上面的投影/DISTINCT ON/ORDER BY 断言全都照样绿（round-3 GLM 探针 P-c 实测）。
      expect(block, 'entry_store 的 FROM 与 ORDER BY 之间被插入了 JOIN / WHERE 等过滤').toMatch(
        /FROM\s+qualifying_days\s+ORDER\s+BY\s+client_user_id,\s*grp,\s*purchase_date,\s*store_id\s*$/,
      )
      expect(
        (block.match(/\bJOIN\b/gi) ?? []).length,
        'entry_store 出现 JOIN —— 它必须是 qualifying_days 的纯去重投影',
      ).toBe(0)
      expect(adminDetail, 'entry_store 丢了 MATERIALIZED —— 执行计划会退化').toMatch(
        /entry_store\s+AS\s+MATERIALIZED\s*\(/,
      )
    })

    /**
     * `xinzeng` 必须**直接从 `entry_store` 派生**（round-1 codex + GLM 同时指出）。
     *
     * 此前这条断言写成 `/xinzeng\s+AS\s*\([\s\S]*?entry_store_id/` —— 没有右边界，
     * 而 `entry_store_id` 在其后的 `new_store`、`store_ids` 里必然出现，所以**恒绿**。
     * 绕过路径：把 `xinzeng` 改回 `FROM first_entry` + 用 `ORDER BY ... LIMIT 1` 形态的
     * 相关子查询取门店（换个拼法即可避开只堵 `MIN(qd.store_id)` 的反向断言），
     * NULL 洞与 O(n²) 双双复活而测试全绿。
     */
    it('xinzeng 直接从 entry_store 派生（四列投影，不回退到 first_entry + 回查）', () => {
      const block = cteBlock(adminDetail, 'xinzeng', 'fugou')
      expect(block, 'xinzeng CTE 未切出').toBeTruthy()
      assertNoNestedCte(block, 'xinzeng')
      expect(block, 'xinzeng 不是从 entry_store 派生').toMatch(/FROM\s+entry_store\b/)
      expect(block, 'xinzeng 的四列投影不完整').toMatch(
        /SELECT\s+client_user_id,\s*grp,\s*entry_date,\s*entry_store_id/,
      )
      expect(block, 'xinzeng 退回 first_entry —— 门店又要靠等值回查（NULL 不安全 + O(n²)）').not.toMatch(
        /FROM\s+first_entry/,
      )
      expect(block, 'xinzeng 体内出现子查询 —— 回查写法复活').not.toMatch(/\(\s*SELECT\s/i)
      // xinzeng 合法地有 WHERE entry_date BETWEEN ...，但不得追加别的谓词
      // ——「过滤掉 grp 为 NULL 的人」正是本 PR 文档化的失败模式。
      // ⚠️ 连续锚：只钉 WHERE 的尾巴挡不住在 FROM 与 WHERE **之间**插一条
      // `JOIN foo ON ... AND grp IS NOT NULL`（round-3 GLM 探针 P-a 实测可绕）。
      expect(block, 'xinzeng 的 FROM 与 WHERE 之间被插入了 JOIN，或 WHERE 追加了区间之外的谓词').toMatch(
        /FROM\s+entry_store\s+WHERE\s+entry_date\s+BETWEEN\s+\$\{range\.start\}\s+AND\s+\$\{range\.end\}\s*$/,
      )
      expect(
        (block.match(/\bJOIN\b/gi) ?? []).length,
        'xinzeng 出现 JOIN —— 它必须是 entry_store 的纯区间切片，任何连接都可能筛掉人',
      ).toBe(0)
    })

    /**
     * ★ `new_store` 的全部结构约束，一律在 CTE 体内断言。
     *
     * round-1 实测出的绕过路径（当时全部全绿）：
     *   E) 计数主体改回 `pa.client_user_id` —— 兜底分组里 `pa.*` 全 NULL，`COUNT(DISTINCT NULL) = 0`
     *   F) 体内加 `WHERE pa.store_id IS NOT NULL` —— 把 LEFT JOIN 打回内连接
     *   A) 换别名写成内连接 + 注释补字面量
     *   H) 加 `HAVING SUM(pa.day_received) > 0` —— entry-only 兜底组 revenue=0 被整体滤掉
     *   J) 追加一条裸 `JOIN period_agg gate ...` —— 不含 INNER/RIGHT/FULL/CROSS 关键字
     */
    it('new_store：以 xinzeng 为主表、恰一条 LEFT JOIN、无 WHERE/HAVING、计数主体是 x', () => {
      const block = cteBlock(adminDetail, 'new_store', 'repurchase_store')
      expect(block, 'new_store 块未切出（CTE 顺序变了？）').toBeTruthy()
      assertNoNestedCte(block, 'new_store')
      // 堵「, LATERAL (SELECT 1 LIMIT 0)」这类零行破坏，以及任何回查子查询
      expect(block, 'new_store 体内出现子查询').not.toMatch(/\(\s*SELECT\s/i)

      // ON 子句整条钉死：JOIN 计数 = 1 只管「有几条连接」，管不住在这一条的 ON 里
      // 追加谓词（如 `AND pa.store_id IS DISTINCT FROM 'store-x'` 把某店业绩挪走，
      // 或 `AND pa.day_received > 0` 把兜底人群的消费行打掉）—— round-3 GLM 探针 P-b 实测可绕。
      expect(block, 'new_store 的主表不是 xinzeng，或 ON 子句被追加了连接键以外的谓词').toMatch(
        /FROM\s+xinzeng\s+x\s+LEFT\s+JOIN\s+period_agg\s+pa\s+ON\s+pa\.client_user_id\s*=\s*x\.client_user_id\s+AND\s+pa\.grp\s*=\s*x\.grp\s+GROUP\s+BY\b/,
      )
      // 恰好一条 JOIN，且必是 LEFT —— 堵「追加一条裸 JOIN 当过滤闸」
      expect(
        (block.match(/\bJOIN\b/gi) ?? []).length,
        'new_store 里的 JOIN 不止一条 —— 多出来的那条会重新过滤掉无 period 行的顾客',
      ).toBe(1)
      expect(block, 'new_store 出现了非 LEFT 的 JOIN').not.toMatch(
        /\b(INNER|RIGHT|FULL|CROSS)\s+JOIN\b/i,
      )
      expect(block, 'new_store 用逗号连接了两个表 —— 等价于内连接').not.toMatch(
        /FROM\s+\w+\s+\w+\s*,/,
      )
      // WHERE 对右表加过滤会把 LEFT JOIN 打回内连接；HAVING 会把 revenue=0 的兜底组整体滤掉
      expect(block, 'new_store 体内出现 WHERE —— 对右表过滤会退化成内连接').not.toMatch(/\bWHERE\b/i)
      expect(
        block,
        'new_store 体内出现 HAVING —— 「只有寄存单进入」的门店 revenue=0，会被整组滤掉（#286 换个写法回归）',
      ).not.toMatch(/\bHAVING\b/i)
      // 计数主体必须是 xinzeng 的顾客：兜底分组里 pa.* 全是 NULL
      expect(block, 'new_store 回退成按 pa 计数').not.toMatch(/COUNT\(DISTINCT\s+pa\.client_user_id\)/)

      /**
       * ★ 整块钉成**字面快照**（round-4 codex 打穿了上一版的"关键子表达式出现过即可"）。
       *
       * 只断言「`COUNT(DISTINCT x.client_user_id)` 出现过」时，下面这两条全绿：
       *
       *   COUNT(DISTINCT x.client_user_id)
       *   - COUNT(DISTINCT CASE WHEN pa.client_user_id IS NULL THEN x.client_user_id END) AS cnt
       *     ↑ 恰好减掉没有 period 行的兜底顾客 —— #286 的主缺陷原地复活
       *
       *   GROUP BY COALESCE(pa.store_id, x.entry_store_id), (pa.client_user_id IS NULL)
       *     ↑ 同一门店裂成两行，product.ts 的 `m.set(store_id, ...)` 后一行覆盖前一行，
       *       **不确定性漏数**（漏哪家取决于行序）
       *
       * 所以这里锁整条投影 + 整条 FROM/JOIN/ON + GROUP BY 锚到块尾，中间不留缝。
       *
       * ⚠️ **这是有意为之的字面快照，不是结构断言**：交换等值条件左右、加括号、
       * 改别名、补显式 ASC 都会误红。这是三轮评审反复打穿"部分结构断言"后的取舍 ——
       * 宁可拦住合理重构（fail-closed，看到红就来读这段注释、确认语义没变再同步更新），
       * 也不能再放过一个让 65.5% 漏损复活的等价变形。
       */
      expect(
        block.trim(),
        'new_store 块与字面快照不符 —— 先确认语义没变（尤其是计数主体与 GROUP BY 维度），再同步更新本断言',
      ).toBe(
        'SELECT COALESCE(pa.store_id, x.entry_store_id) AS store_id, ' +
          'COUNT(DISTINCT x.client_user_id) AS cnt, ' +
          'COALESCE(SUM(pa.day_received), 0) AS revenue ' +
          'FROM xinzeng x ' +
          'LEFT JOIN period_agg pa ' +
          'ON pa.client_user_id = x.client_user_id AND pa.grp = x.grp ' +
          'GROUP BY COALESCE(pa.store_id, x.entry_store_id)',
      )
    })

    it('store_ids 骨架并上 entry 门店（否则只有寄存单进入的门店会漏行）', () => {
      const block = lastCteBlock(adminDetail, 'store_ids')
      expect(block, 'store_ids 块未切出').toBeTruthy()
      assertNoNestedCte(block, 'store_ids')
      // ⚠️ 必须锚到**块尾**：只匹配前缀的话，追加 `AND FALSE` 之类谓词仍然全绿，
      // 而 entry-only 门店就不进骨架、new_store 算出的人数在最终 JOIN 再次丢失（round-2 codex）
      expect(block, 'store_ids 未并上 xinzeng 的 entry 门店，或 UNION 分支被追加了额外谓词').toMatch(
        /FROM\s+period_agg\s+UNION\s+SELECT\s+DISTINCT\s+entry_store_id\s+FROM\s+xinzeng\s+WHERE\s+entry_store_id\s+IS\s+NOT\s+NULL\s*$/,
      )
    })

    /**
     * ★ 最终 SELECT 也必须守护（round-4 codex）。
     *
     * 前面所有断言都切到 `store_ids` 就结束了 —— CTE 全部算对，结果仍可在**消费端**被丢掉：
     *
     *   LEFT JOIN new_store n ON n.store_id = s.store_id AND n.revenue > 0
     *
     * 这一条就把「只有寄存单进入、零销售单消费」的门店（revenue = 0）重新滤掉，
     * 正好抵消 `store_ids` 第二个 UNION 分支要保护的场景，而上面的断言无一触发。
     *
     * 同理，把 `COALESCE(n.cnt, 0) AS new_count` 改成 `COALESCE(n.cnt, 0) * 0` 之类也无人拦。
     * 与 `new_store` 同样处理：**字面快照**，见上面那段关于 fail-closed 取舍的说明。
     */
    it('最终 SELECT 未被追加过滤（CTE 算对了也能在消费端丢行）', () => {
      const finalSelect = /\)\s*(SELECT\s[\s\S]*)$/.exec(adminDetail)?.[1] ?? ''
      expect(finalSelect, '最终 SELECT 未切出 —— 切片口径需同步更新').toBeTruthy()
      expect(
        finalSelect.trim(),
        '最终 SELECT 与字面快照不符 —— 尤其检查三条 LEFT JOIN 的 ON 有没有被追加谓词（会再次丢行）',
      ).toBe(
        'SELECT s.store_id AS store_id, ' +
          'COALESCE(t.cnt, 0) AS trial_count, ' +
          'COALESCE(n.cnt, 0) AS new_count, ' +
          'COALESCE(n.revenue, 0) AS new_revenue, ' +
          'COALESCE(r.cnt, 0) AS repurchase_count, ' +
          'COALESCE(r.revenue, 0) AS repurchase_revenue ' +
          'FROM store_ids s ' +
          'LEFT JOIN trial_store t ON t.store_id = s.store_id ' +
          'LEFT JOIN new_store n ON n.store_id = s.store_id ' +
          'LEFT JOIN repurchase_store r ON r.store_id = s.store_id',
      )
    })

    /**
     * 体验/复购不需要兜底：`tiyan` 本就从 `period_agg` 派生，
     * `fugou` 要求 `purchase_received >= threshold > 0`，两者必然在 `period_agg` 里有行。
     * 锁住这一点，免得日后有人"顺手"把它们也改成 LEFT JOIN 兜底，反而引入无处归店的行。
     */
    it('体验/复购仍以 period_agg 为主表（它们必然有 period 行，无需兜底）', () => {
      const trial = cteBlock(adminDetail, 'trial_store', 'new_store')
      const repurchase = cteBlock(adminDetail, 'repurchase_store', 'store_ids')
      expect(trial, 'trial_store 块未切出').toBeTruthy()
      expect(repurchase, 'repurchase_store 块未切出').toBeTruthy()
      expect(trial).toMatch(/FROM\s+period_agg\s+pa\s+JOIN\s+tiyan\s+t/)
      expect(repurchase).toMatch(/FROM\s+period_agg\s+pa\s+JOIN\s+fugou\s+fg/)
      // 与 new_store 同理：正向断言只认前缀，追加第二条 JOIN 当过滤闸仍然全绿
      expect((trial.match(/\bJOIN\b/gi) ?? []).length, 'trial_store 的 JOIN 不止一条').toBe(1)
      expect(
        (repurchase.match(/\bJOIN\b/gi) ?? []).length,
        'repurchase_store 的 JOIN 不止一条',
      ).toBe(1)
    })

    /**
     * staff 端哨兵：`mgmt-product.js` 目前**没有按门店的归店聚合** —— 三段 UNION ALL 都按
     * `product_kind` 分组。它确实有一条含 `store_id` 的 `GROUP BY`
     * （`daily_agg` 的 `(client_user_id, store_id, product_kind, performance_date)` 四键基础聚合），
     * 那是**逐日逐店的原始聚合**、不是归店输出，必须放行。
     *
     * ⚠️ 这条哨兵前两版都被评审打穿过，所以改用**全量 snapshot**：
     *   v1 `/GROUP BY\s+[\w.]*store_id/` —— 要求 store_id 紧跟 GROUP BY，
     *      `GROUP BY product_kind, store_id` 被逗号挡住而假绿；且当时注释声称
     *      「staff 全文零 GROUP BY store_id」**与事实不符**（`mgmt-product.js:259` 就有）。
     *   v2 「凡含 store_id 的 GROUP BY 必须同时含 performance_date」—— 判据方向对，但实现
     *      退化成字面单空格 + 大小写敏感 + 用 `)` 当终止符（`COALESCE(a, b)` 会截断），
     *      且 `GROUP BY 1, 2` 这种序号分组根本不含 store_id 字面量，全部漏检（fail-open）。
     *
     * 现在锁**整份清单**：staff 任何 GROUP BY 的新增/改写都会红，强制人工确认它是不是
     * 归店聚合。若确认是归店明细，必须同步 #286 的「xinzeng 主表 + entry_store_id 兜底」口径。
     */
    it('staff 的 GROUP BY 清单未变（新增归店聚合时必须同步 #286 的归店口径）', () => {
      // 先剥 SQL 行注释，避免 `GROUP BY store_id -- performance_date` 这类注入；大小写不敏感。
      const staffSqlOnly = stripComments(staffSrc).replace(/--[^\n]*/g, ' ')
      /**
       * ⚠️ **不能用「`group\s+by\s+` 后跟 `[^\n` + 反引号 `]*`」这种匹配**
       * （round-3 codex 实测打穿）：它在换行处停，于是**续行追加的分组键看不见** ——
       *
       *   GROUP BY x.product_kind
       *          , x.store_id        ← 提取结果仍是 'GROUP BY x.product_kind'
       *
       * 清单不变、`withStoreId` 仍只有 1 条，哨兵**静默假绿**，而 staff 已经长出归店聚合。
       *
       * ⚠️ **也不能简单拿 `)` / `),` 当终止符**（round-2 GLM 指出的 v2 缺陷）：
       * `GROUP BY COALESCE(a, b)` 会在函数的闭括号处被截断。
       *
       * 所以先把空白压平（跨行 GROUP BY 变成一条），再**按括号深度扫描**找真正的右边界：
       * 深度 0 时遇到多余的 `)`（CTE 收尾）、反引号、分号，或 `HAVING` / `UNION` /
       * `ORDER BY` / `LIMIT` / `WINDOW` 关键字才停；函数调用里的括号不会误判。
       */
      const flat = staffSqlOnly.replace(/\s+/g, ' ')
      const readGroupBy = (from: number): string => {
        let i = from
        let depth = 0
        while (i < flat.length) {
          const ch = flat[i]
          if (ch === '(') depth++
          else if (ch === ')') {
            if (depth === 0) break
            depth--
          } else if (ch === '`' || ch === ';') break
          else if (depth === 0 && i > from && /^(?:having|union|order\s+by|limit|window)\b/i.test(flat.slice(i))) break
          i++
        }
        return flat.slice(from, i).replace(/\s+/g, ' ').trim()
      }
      const groupBys: string[] = []
      const gbRe = /group\s+by\s+/gi
      let gbMatch: RegExpExecArray | null
      while ((gbMatch = gbRe.exec(flat)) !== null) groupBys.push(readGroupBy(gbMatch.index))
      expect(groupBys, 'staff 的 GROUP BY 清单发生变化 —— 新增按门店的归店聚合时请同步 #286').toEqual([
        'GROUP BY pc.product_kind',
        'GROUP BY so.client_user_id, so.store_id, pc.product_kind, sipe.performance_date',
        'GROUP BY client_user_id, product_kind',
        'GROUP BY t.product_kind',
        'GROUP BY x.product_kind',
        'GROUP BY f.product_kind',
      ])
      // 双保险：清单里唯一允许含 store_id 的那条，必须是带日期维度的逐日基础聚合
      const withStoreId = groupBys.filter((g) => /store_id/i.test(g))
      expect(withStoreId, '含 store_id 的 GROUP BY 不止一条').toHaveLength(1)
      expect(withStoreId[0], '唯一含 store_id 的 GROUP BY 不是逐日基础聚合 —— 这是归店聚合').toMatch(
        /performance_date/,
      )
    })
  })

  describe('业绩 = SUM(支付事件 amount)（禁 paid_amount）', () => {
    it('两端禁用 paid_amount（已 DROP，防回归）', () => {
      expect(adminCode).not.toMatch(/paid_amount/)
      expect(staffCode).not.toMatch(/paid_amount/)
    })
  })

  describe('一级分组键 = product_kind（admin 额外支持 category_name 二级下钻）', () => {
    it('staff 按 product_kind 分组（GROUP BY ... pc.product_kind）', () => {
      expect(staffCode).toMatch(/pc\.product_kind/)
    })
    it('admin 含 product_kind（一级）与 category_name（二级扩展）', () => {
      expect(adminCode).toMatch(/pc\.product_kind/)
      expect(adminCode).toMatch(/pc\.category_name/)
    })
  })

  describe('占比分母 = 会员数（became_member_at，截面无 $date 守卫）', () => {
    it('admin 会员数用 became_member_at IS NOT NULL', () => {
      expect(adminCode).toMatch(/became_member_at\s+IS\s+NOT\s+NULL/)
    })
    it('staff 会员数用 became_member_at IS NOT NULL', () => {
      expect(staffCode).toMatch(/became_member_at\s+IS\s+NOT\s+NULL/)
    })
  })

  describe('JOIN 链 = sale_items → sale_orders → product_skus → product_categories', () => {
    it('admin 含 product_skus + product_categories JOIN', () => {
      expect(adminCode).toMatch(/JOIN\s+product_skus\s+sk\s+ON\s+sk\.sku_id\s*=\s*si\.sku_id/)
      expect(adminCode).toMatch(/JOIN\s+product_categories\s+pc\s+ON\s+pc\.category_id\s*=\s*sk\.category_id/)
    })
    it('staff 含 product_skus + product_categories JOIN', () => {
      expect(staffCode).toMatch(/JOIN\s+product_skus\s+sk\s+ON\s+sk\.sku_id\s*=\s*si\.sku_id/)
      expect(staffCode).toMatch(/JOIN\s+product_categories\s+pc\s+ON\s+pc\.category_id\s*=\s*sk\.category_id/)
    })
  })

  describe('维护者提醒 — 漂移时双端对照', () => {
    it('admin 注释提及移植源 mgmt-product', () => {
      expect(adminSrc).toMatch(/mgmt-product/i)
    })
  })
})
