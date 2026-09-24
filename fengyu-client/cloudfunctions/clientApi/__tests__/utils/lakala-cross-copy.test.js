/**
 * 拉卡拉工具跨副本一致性守护
 *
 * 项目规范：禁止跨端共享代码目录，clientApi / payNotify / admin 各保留独立 lakala 副本，
 * 一致性靠测试守护（详见根 CLAUDE.md「禁止跨端共享代码目录」）。
 *
 * 守护两件事：
 *  1. clientApi 与 payNotify 的 lakala-sign.js / lakala-config.js **字节一致**（签名算法 + PEM 归一化不漂移）。
 *  2. 三端（clientApi / payNotify / admin）的配置读取都含 `normalizePem`（PEM \n 归一化），
 *     防止有人删掉它导致 `DECODER routines::unsupported` 加签/验签全挂的回归（联调根因）。
 */
const fs = require('fs')
const path = require('path')

const CLIENT = path.resolve(__dirname, '../../utils')
const PAYNOTIFY = path.resolve(__dirname, '../../../payNotify/utils')
const ADMIN_LAKALA_CLIENT = path.resolve(
  __dirname,
  '../../../../../fengyu-admin/src/lib/lakala-client.ts',
)

function read(p) {
  return fs.readFileSync(p, 'utf8')
}

describe('lakala 跨副本一致性守护', () => {
  test('lakala-sign.js：clientApi 与 payNotify 字节一致', () => {
    expect(read(path.join(CLIENT, 'lakala-sign.js'))).toBe(
      read(path.join(PAYNOTIFY, 'lakala-sign.js')),
    )
  })

  test('lakala-config.js：clientApi 与 payNotify 字节一致', () => {
    expect(read(path.join(CLIENT, 'lakala-config.js'))).toBe(
      read(path.join(PAYNOTIFY, 'lakala-config.js')),
    )
  })

  test('lakala-client.js：clientApi 与 payNotify 字节一致（issue #37 定时补偿新增 payNotify 副本，queryTrade 字段映射 / 签名不漂移）', () => {
    expect(read(path.join(CLIENT, 'lakala-client.js'))).toBe(
      read(path.join(PAYNOTIFY, 'lakala-client.js')),
    )
  })

  test('三端配置读取都含 PEM \\n 归一化（normalizePem），防 DECODER unsupported 回归', () => {
    expect(read(path.join(CLIENT, 'lakala-config.js'))).toContain('normalizePem')
    expect(read(path.join(PAYNOTIFY, 'lakala-config.js'))).toContain('normalizePem')
    expect(read(ADMIN_LAKALA_CLIENT)).toContain('normalizePem')
  })

  // ===== #214 支付意图关单：三端接口与终态集合一致性 =====
  describe('#214 关单接口与 trade_state 终态集合', () => {
    const CLIENT_ORDER = path.resolve(__dirname, '../../routes/order.js')
    const PAYNOTIFY_INDEX = path.resolve(__dirname, '../../../payNotify/index.js')
    const ADMIN_ORDERS = path.resolve(
      __dirname, '../../../../../fengyu-admin/src/actions/orders.ts',
    )

    test('admin 的关单/查单走与 js 副本相同的 v3 路径与字段名', () => {
      const admin = read(ADMIN_LAKALA_CLIENT)
      const client = read(path.join(CLIENT, 'lakala-client.js'))
      for (const token of ['/v3/labs/relation/close', '/v3/labs/query/tradequery', 'origin_out_trade_no']) {
        expect(admin).toContain(token)
        expect(client).toContain(token)
      }
    })

    // 这条锁死的是 #214 真正的坑：REVOKED（当日交易撤销）是终态却长期被漏判，
    // 撤销过的单会永久占住支付意图——谁也发不了新支付、谁也关不掉订单。
    // pr-ready 审计发现首轮修复本身就漏了 queryLakalaStatus / confirmPayment 两处，
    // 所以这里直接把旧集合字面量钉成永久红灯，而不是只断言新集合存在。
    test('生产代码不得再出现 [FAIL, CLOSE] 旧终态集合（REVOKED 必须在列）', () => {
      const OLD_SET = /\[\s*'FAIL',\s*'CLOSE'\s*\]/
      for (const file of [CLIENT_ORDER, PAYNOTIFY_INDEX, ADMIN_ORDERS]) {
        const src = read(file)
          .split('\n')
          .filter((line) => !/^\s*(\*|\/\/)/.test(line))   // 注释里可以保留历史说明
          .join('\n')
        expect(src).not.toMatch(OLD_SET)
      }
    })

    test('三端终态分类字面一致（可释放 3 个 / 已付款 3 个）', () => {
      const RELEASABLE = /\[\s*'FAIL',\s*'CLOSE',\s*'REVOKED'\s*\]/
      const PAID = /\[\s*'SUCCESS',\s*'PART_REFUND',\s*'REFUND'\s*\]/
      for (const file of [CLIENT_ORDER, ADMIN_ORDERS]) {
        const src = read(file)
        expect(src).toMatch(RELEASABLE)
        expect(src).toMatch(PAID)
      }
      // payNotify 是被动兜底，只需认得可释放终态（它不做关单）
      expect(read(PAYNOTIFY_INDEX)).toMatch(/\[\s*'FAIL',\s*'CLOSE',\s*'REVOKED'\s*\]/)
      expect(read(PAYNOTIFY_INDEX)).toContain("tradeState === 'REVOKED'")
    })

    // clientApi 的跨 env 作废接口与 staffApi 的关单前闸门必须认同一组「可关闭状态」：
    // 两端漂移会让 staff 放行、clientApi 拒绝（或反之），表现为莫名其妙的「状态已变化」。
    test('可关闭订单状态集合三端一致（待支付 / 支付失败）', () => {
      const STAFF_ORDER = path.resolve(
        __dirname, '../../../../../fengyu-staff/cloudfunctions/staffApi/routes/order.js',
      )
      const SET_LITERAL = /\[\s*'待支付',\s*'支付失败'\s*\]/
      expect(read(CLIENT_ORDER)).toMatch(SET_LITERAL)
      expect(read(STAFF_ORDER)).toMatch(SET_LITERAL)
      expect(read(ADMIN_ORDERS)).toMatch(SET_LITERAL)
      // 三端都应通过具名常量引用，而不是散落字面量
      expect(read(CLIENT_ORDER)).toContain('CLOSEABLE_ORDER_STATUSES')
      expect(read(STAFF_ORDER)).toContain('CLOSEABLE_ORDER_STATUSES')
      expect(read(ADMIN_ORDERS)).toContain('CLOSEABLE_ORDER_STATUSES')
    })

    // scanDetail 下发的 resumablePrepaidCardAmount 取自订单行当前的 pending 卡额，
    // 它等于「该渠道单的卡额」这一点，依赖**意图活跃期没有任何路径能改待扣卡额**。
    // 这个跨端不变量一旦被旁路，页面展示的抵扣就会和渠道单实际金额分叉
    // （双谱系评审 round-10）。这里把三端的守卫钉成字面量。
    test('意图活跃期改待扣卡额的路径三端都有 PAYMENT_INTENT_ACTIVE 守卫', () => {
      const client = read(CLIENT_ORDER)
      // 顾客端：调整抵扣方案 / 改用储值卡支付
      expect(client).toContain('暂不能调整抵扣方案')
      expect(client).toContain('暂不能改用储值卡支付')
      // admin：待结算储值卡支付意图
      expect(read(ADMIN_ORDERS)).toContain('订单已有待结算储值卡支付意图')
    })

    // fail-closed 是整个关单流程的承重结构：关单返回成功 ≠ 渠道已终态，
    // 必须复核；复核不过一律不释放本地意图。两份 helper 都不许绕过。
    test('clientApi 与 admin 的作废 helper 都保留「关单后复核」结构', () => {
      for (const file of [CLIENT_ORDER, ADMIN_ORDERS]) {
        const src = read(file)
        expect(src).toContain('closeTrade')
        // 关单之后必须再查一次
        expect(src).toMatch(/closeTrade[\s\S]{0,1200}queryTrade/)
        // 释放意图的 CAS 必须锚当前单号
        expect(src).toMatch(/lakala_out_order_no = (\$2|\$\{outTradeNo\})/)
      }
    })
  })

  /**
   * meta-guard：本守护必须跑在 CI 里，否则它只在本地存在，拦不住回归合入。
   *
   * 这个文件正是「守护写好了却从未执行」的原始反面教材 —— 它守着拉卡拉签名与
   * PEM 归一化的字节一致性（漂了就是加签/验签全挂），却因为 clientApi 没有任何
   * CI job 而一次没跑过。#232 想加 job，被 `__tests__/routes/order.test.js` 里
   * 一条 #154 漏改的过时断言挡住；断言在 #276 修好后，job 才补上。
   *
   * 仿 `fengyu-staff/.../__tests__/utils/image-cross-copy.test.js` 的同型 meta-guard，
   * 但**解析 YAML 而不是用正则猜它**。初版是正则版，双谱系评审连着两轮从它身上找出
   * 一整串绕过：行尾注释（`- 'README.md' # - '...'` 让 toContain 匹配到注释里的串）、
   * 带引号的键（`"if": ${{ false }}` 躲开 /^\s*if:/）、块标量 `run: |` 误报……
   * 每堵一个就再冒一个，因为用正则模拟 YAML 语义本身就是条走不通的路。
   * 改成真解析器后这一整类绕过一次性消失 —— 断言的是**解析后的语义**，
   * 写法怎么变都不影响。
   */
  test('meta：CI 跑的是 clientApi 全量 vitest，不是手工文件清单', () => {
    const YAML = require('yaml')
    const lintYml = path.resolve(__dirname, '../../../../../.github/workflows/lint.yml')
    const wf = YAML.parse(read(lintYml))

    // `on` 在 YAML 1.1 里是布尔真值，js 侧键名可能是 true 也可能是 'on'
    const triggers = wf.on || wf[true]
    const paths = triggers.pull_request.paths || []

    // 触发面有**四个**否定开关，堵一个不够（闸门 2 的 GLM 逐个实测穿网）：
    // - paths-ignore：一条 `['.../clientApi/**']` 就让只改 clientApi 的 PR 全不触发
    // - branches：⚠️ 本仓 PR base 是 **dev 不是 main**，从别的仓库拷片段带一条
    //   `branches: [main]` 进来，**所有** PR 都不再触发任何 job——这是最自然的误改
    // - branches-ignore：同理，反向写法
    // 四个当前一处都没用，全面禁掉零成本。
    for (const key of ['paths-ignore', 'branches', 'branches-ignore']) {
      expect(triggers.pull_request[key], `pull_request.${key} 会让触发面塌掉`).toBeUndefined()
    }
    // types 不能省掉 synchronize：只留 `[opened]` 的话，PR 开出后续 push 的代码全部免检，
    // 第一个 commit 之后想怎么改都不会再跑守护。不写 types 时 GitHub 默认含 synchronize。
    const types = triggers.pull_request.types
    if (types !== undefined) {
      expect(types, 'types 省掉 synchronize 会让 PR 后续 push 免检').toContain('synchronize')
    }

    // paths 必须覆盖本守护实际读到的**全部**文件，否则「改了但不触发」等于没有守护。
    // 本文件跨四个目录读源码做字面比对：
    // - clientApi / payNotify 的 lakala-*.js 与 routes/order.js、index.js
    // - staffApi 的 routes/order.js（可关闭订单状态集合三端一致）
    // - admin 的 lib/lakala-client.ts 与 actions/orders.ts（v3 路径、终态集合、CAS 锚单号）
    // - lint.yml 自身：改 workflow 必须让本守护有机会拦下「把全量改回清单」
    for (const p of [
      'fengyu-client/cloudfunctions/**/*.js',
      'fengyu-staff/cloudfunctions/**/*.js',
      'fengyu-admin/src/**/*.ts',
      '.github/workflows/lint.yml',
    ]) {
      expect(paths, `paths 缺 ${p}，改了它却不触发 CI = 守护失效`).toContain(p)
    }

    // 本 job 靠 `npm ci` 装依赖才跑得起来，所以依赖清单也必须在触发面内。
    // ⚠️ 上面 `fengyu-client/cloudfunctions/**/*.js` 的 glob **不匹配 .json** ——
    // 少了这两条，「只升 vitest/pg 版本号」的 PR 命中不到任何条目，整个 workflow
    // 全不触发，而依赖升级恰恰是最该让全量守护跑一遍的那次。admin 侧早为此加过同款（#232）。
    for (const p of [
      'fengyu-client/cloudfunctions/clientApi/package.json',
      'fengyu-client/cloudfunctions/clientApi/package-lock.json',
    ]) {
      expect(paths, `paths 缺 ${p}，依赖升级 PR 不会触发任何 job`).toContain(p)
    }

    const job = wf.jobs['clientapi-tests']
    expect(job, 'lint.yml 里没有 clientapi-tests job').toBeDefined()

    // job 级的跳过/放水：`if:` 让整个 job 不跑，`continue-on-error:` 让它红了也算通过。
    // 两者都不改 run 命令文本，纯文本断言看不见。
    expect(job.if, 'clientapi-tests 被 if: 条件化，可能整个 job 被跳过').toBeUndefined()
    expect(job['continue-on-error'], 'clientapi-tests 失败也会算通过').toBeUndefined()
    expect(job.needs, 'clientapi-tests 挂了 needs，上游 job 跳过会连带跳过它').toBeUndefined()

    const steps = job.steps || []
    for (const s of steps) {
      expect(s.if, `step「${s.name || s.uses}」被 if: 条件化`).toBeUndefined()
      expect(s['continue-on-error'], `step「${s.name || s.uses}」失败也算通过`).toBeUndefined()
    }

    const inClientApi = steps.filter(
      (s) => s['working-directory'] === 'fengyu-client/cloudfunctions/clientApi',
    )

    // 装依赖只能是干净的 `npm ci`。`npm install` / `npm ci || npm install` 都不行：
    // 前者在 package.json 与 lockfile 不一致时就地重写 lockfile 继续跑，让本该失败的
    // 情形变绿，正好抵消把依赖清单加进 paths 的目的。
    const installRuns = inClientApi.map((s) => (s.run || '').trim()).filter((c) => /npm (ci|install)/.test(c))
    expect(installRuns, '装依赖必须恰好是干净的 npm ci').toEqual(['npm ci'])

    // ⚠️ 断言测试命令**恰好**是不带任何参数的 `npx vitest run`，而不是用负向正则去猜
    // 「手工清单长什么样」——负向匹配挡不住 `--dir __tests__/utils`、`-t <pattern>`、
    // `--project` 这些同样会缩小范围的写法。
    //
    // 已知且**刻意**的代价：改成 `npm test`（哪怕 package.json 的 test 脚本一字不差
    // 就是 `vitest run`）本守护会误报变红。这是「宁可误杀等价重构，也不放过任何缩小
    // 范围的写法」的取舍——误报方向安全，漏报方向才让守护失效。
    // **遇到误报不要放宽断言**，把 job 写回 `npx vitest run` 即可。
    const testRuns = inClientApi.map((s) => (s.run || '').trim()).filter((c) => c.includes('vitest'))
    expect(testRuns, 'CI 必须跑 clientApi 全量 vitest').toEqual(['npx vitest run'])

    // 最后一环：`npx vitest run` 到底收集哪些文件，由 vitest.config.js 的 include/exclude
    // 决定，不是 lint.yml。缩小 include（或加一条 exclude）后 CI 命令一字未动、本守护
    // 自己（在 utils 下）照样执行，另外 35 个文件却全部出网 —— 这比改 lint.yml 更顺手，
    // 也更像「配置调整」而非「写手工清单」。
    //
    // ⚠️ 这里断言的是 `include`/`exclude` 而不是 `testMatch`：`testMatch` **不是 vitest
    // 的选项**（jest 才是），写在 config 里会被静默忽略。本仓库原先就写着它，实测把它
    // 缩到只剩 utils，36 个文件照跑不误 —— 守它等于守了个空字段（双谱系 round-2 发现，
    // 已一并把 config 改成真正生效的 include）。
    // node 18 canary：补上「主 job 跑 node 22，测不出生产运行时 Nodejs18.15」的缺口。
    // 它不跑测试、只 require 生产模块，所以不受 vite 7 不支持 node 18 的限制。
    const canary = wf.jobs['clientapi-node18-canary']
    expect(canary, '缺 node18 canary job，生产运行时兼容性零覆盖').toBeDefined()
    expect(
      JSON.stringify(canary.steps).includes('18.15'),
      'canary 必须跑在 18.15（与 cloudbaserc 的 runtime 对齐）',
    ).toBe(true)

    const vitestConfig = read(path.resolve(__dirname, '../../vitest.config.js'))
    expect(vitestConfig, 'include 被改窄会让测试文件静默出网').toContain(
      "include: ['**/__tests__/**/*.test.js']",
    )
    expect(vitestConfig, 'testMatch 不是 vitest 选项，会被静默忽略，别用它').not.toContain('testMatch')
    expect(vitestConfig, '加 exclude 同样能让文件出网').not.toContain('exclude:')
    // `projects` 会整个接管文件收集，留着上面的 include 也没用（闸门 2 的 GLM 指出）。
    expect(vitestConfig, 'projects 会接管收集，绕过 include').not.toMatch(/^\s*projects:/m)
  })
})
