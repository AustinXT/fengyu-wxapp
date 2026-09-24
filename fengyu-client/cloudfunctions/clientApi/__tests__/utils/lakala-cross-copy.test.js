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
    // types 是第五个开关，而且**两个方向都能漏**：只留 `[opened]` 会让 PR 后续 push
    // 全部免检；只留 `[synchronize]` 则让「用已有提交新建的 PR」压根不触发（首次只发
    // opened 事件）。缺省值 opened+synchronize+reopened 就是对的，所以直接要求不写它，
    // 真要写必须写全（闸门 2 codex round-3 → round-4 连续两次收紧）。
    const types = triggers.pull_request.types
    if (types !== undefined) {
      expect([...types].sort(), 'types 写了就必须覆盖默认三事件，否则总有一类 PR 免检')
        .toEqual(['opened', 'reopened', 'synchronize'])
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

    // ⚠️ paths **内部**也能写否定规则：GitHub 支持 `!` 前缀，末尾追加一条
    // `- '!fengyu-client/cloudfunctions/**'` 就把前面的正向规则全抵消掉，
    // 而上面那些 toContain 照样全绿、paths-ignore 也确实不存在（闸门 2 codex round-3 指出）。
    expect(
      paths.filter((p) => String(p).startsWith('!')),
      'paths 里出现 ! 否定规则，会把正向触发面抵消掉',
    ).toEqual([])

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

    // job 级与 step 级的跳过/放水：`if:` 让它不跑，`continue-on-error:` 让它红了也算通过，
    // `needs:` 让上游跳过时连带跳过。三者都不改 run 命令文本，纯文本断言看不见。
    // ⚠️ 两个 job 都要查 —— canary 只守了 node 版本、没守执行与失败传播时，
    // 给它加一条 `if: ${{ false }}` 就能让生产运行时兼容性悄悄回到零覆盖
    // （闸门 2 codex round-4 指出）。
    const assertJobActuallyRuns = (jobName) => {
      const j = wf.jobs[jobName]
      expect(j, `lint.yml 里没有 ${jobName} job`).toBeDefined()
      expect(j.if, `${jobName} 被 if: 条件化，可能整个 job 被跳过`).toBeUndefined()
      expect(j['continue-on-error'], `${jobName} 失败也会算通过`).toBeUndefined()
      expect(j.needs, `${jobName} 挂了 needs，上游 job 跳过会连带跳过它`).toBeUndefined()
      for (const s of j.steps || []) {
        expect(s.if, `${jobName} 的 step「${s.name || s.uses}」被 if: 条件化`).toBeUndefined()
        expect(s['continue-on-error'], `${jobName} 的 step「${s.name || s.uses}」失败也算通过`).toBeUndefined()
      }
      return j
    }

    const job = assertJobActuallyRuns('clientapi-tests')
    const steps = job.steps || []

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
    const canary = assertJobActuallyRuns('clientapi-node18-canary')
    // ⚠️ 必须读 setup-node 的 `with.node-version` 本身。不要用「steps 的 JSON 里
    // 含字符串 18.15」这种糊涂写法 —— step 名字「Require ... under Nodejs18.15」
    // 自己就含这串，把 node-version 改成 22 照样绿（闸门 2 codex round-3 实测）。
    const canaryNode = (canary.steps || [])
      .filter((s) => String(s.uses || '').startsWith('actions/setup-node'))
      .map((s) => String((s.with || {})['node-version']))
    expect(canaryNode, 'canary 必须跑在 18.15（与 cloudbaserc 的 runtime 对齐）').toEqual(['18.15'])
    // 命令本身也要锁：缩成只 `require('./index.js')` 的话，路由模块顶层的 node 20+ API
    // 就测不到了，canary 名存实亡（闸门 2 codex round-4 指出）。
    // ⚠️ 声明极限：这是**文本**匹配，不是行为验证。在 run 里 echo 一句同样的字面量、
    // 或把真调用塞进 `if (false)` 死代码，断言照样绿而模块并没被 require
    // （闸门 2 的 GLM 指出）。与 SQL 侧「守形状不守取值」同族——挡自然疏忽，挡不住刻意构造。
    const canaryRun = (canary.steps || []).map((s) => s.run || '').join('\n')
    expect(canaryRun, 'canary 必须遍历 routes/ 逐个 require，不能只 require 入口')
      .toMatch(/readdirSync\('routes'\)/)
    expect(canaryRun, 'canary 必须 require 入口 index.js').toMatch(/require\('\.\/index\.js'\)/)

    // ⚠️ 剥掉 JS 行注释再断言：否则「把旧 include 留在注释里、下一行写窄的」就能让
    // 下面的 toContain 照样匹配到注释（闸门 2 codex round-4 实测）。与 SQL 侧同型的坑。
    const vitestConfig = read(path.resolve(__dirname, '../../vitest.config.js'))
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n')
    expect(vitestConfig, 'include 被改窄会让测试文件静默出网').toContain(
      "include: ['**/__tests__/**/*.test.js']",
    )
    // ⚠️ 只断言「全量字面量出现过」不够：JS 对象里**重复的键后者生效**，
    // 在下面再写一行 `include: ['**/__tests__/utils/**/*.test.js'],` 就能把收集缩到
    // 16 文件 / 246 用例，而 vitest 只给一条 duplicate-key warning 不报错，
    // 上面那条 toContain 照样匹配到第一行（闸门 2 codex round-5 实测）。
    // test 块的 include 必须**有且只有一条**（coverage 块里那条缩进更深，不计入）。
    const testIncludes = vitestConfig.match(/^ {4}include:/gm) || []
    expect(testIncludes, 'test.include 出现多次时后者生效，会悄悄缩小收集范围').toHaveLength(1)
    // `shard: '1/2'` 只跑一半文件，而本守护恰好落在前半所以自己照样执行
    // —— 「想给 CI 分片却漏配第二个 shard」是自然疏忽（闸门 2 codex round-6 指出）。
    expect(vitestConfig, 'shard 会让每次只跑一部分文件').not.toContain('shard')
    expect(vitestConfig, 'testMatch 不是 vitest 选项，会被静默忽略，别用它').not.toContain('testMatch')
    expect(vitestConfig, '加 exclude 同样能让文件出网').not.toContain('exclude:')
    // `projects` 会整个接管文件收集，留着上面的 include 也没用（闸门 2 的 GLM 指出）。
    expect(vitestConfig, 'projects 会接管收集，绕过 include').not.toMatch(/^\s*projects:/m)
    // `testNamePattern` 是按**用例名**过滤，不改收集范围也能让 876 条静默跳过而 CI 全绿
    // —— 「临时调试过滤器忘了删」是最自然的进入路径；`dir` 则直接换根目录
    // （闸门 2 codex round-3 指出）。
    expect(vitestConfig, 'testNamePattern 会让绝大多数用例静默跳过').not.toContain('testNamePattern')
    expect(vitestConfig, 'dir 会换掉测试根目录').not.toMatch(/^\s*dir:/m)
  })

  /**
   * 上面那条 meta 守的是「配置长什么样」，靠**枚举**所有能缩小收集范围的写法
   * （exclude / projects / testNamePattern / dir / 重复键 / shard …）。双谱系评审
   * 连着三轮每轮都能再举出一个没被枚举到的 —— 那是个开放集合，枚举永远不完备。
   *
   * 这条换个路子：**不看配置，直接核对实际收集结果**。`vitest list` 只做收集、不执行
   * 用例（所以不会递归触发本文件），把它列出的文件数与磁盘上真实存在的 `*.test.js`
   * 数对齐，一次性关掉整个类别 —— 不管是哪个配置字段、自动发现的
   * `vitest.workspace.*` / `vitest.projects.*`、还是分片，只要最终少收集了文件，这里就红。
   *
   * 上面那条枚举式断言**保留**：它快，且能直接点出是哪个字段出的问题；
   * 这条负责兜住枚举不到的部分。
   */
  test('meta：vitest 实际收集到的文件数 == 磁盘上真实存在的测试文件数', () => {
    const { execFileSync } = require('child_process')
    const root = path.resolve(__dirname, '../..')

    const listed = execFileSync('npx', ['vitest', 'list', '--filesOnly'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.endsWith('.test.js'))

    const onDisk = []
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.test.js')) onDisk.push(p)
      }
    }
    walk(path.join(root, '__tests__'))

    expect(
      listed.length,
      `vitest 只收集到 ${listed.length} 个文件，磁盘上却有 ${onDisk.length} 个`
        + ' —— 有东西在缩小收集范围（配置字段 / vitest.workspace.* / vitest.projects.* / shard）',
    ).toBe(onDisk.length)
  })
})
