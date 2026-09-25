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

      // fail-closed：正则失配（比如源码重构后换了写法）不得静默通过
      expect(
        lines.length,
        `${probe.label}：在 ${probe.file} 里按 ${probe.pattern} 只提取到 ${lines.length} 行，` +
          `少于预期的 ${probe.minLines} 行。要么源码口径变了（请同步更新本探针的 pattern/minLines），` +
          '要么正则失配 —— 无论哪种，都不能让这条守护静默通过。',
      ).toBeGreaterThanOrEqual(probe.minLines)

      const missing = [...new Set(lines)].filter((l) => !dist.includes(l))
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
