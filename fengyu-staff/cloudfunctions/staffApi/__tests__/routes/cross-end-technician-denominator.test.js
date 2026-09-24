/**
 * 「产能技师」人均分母的跨端字面量守护（issue #320）。
 *
 * staff `routes/mgmt-dashboard.js` 的 `queryEmployeeCount` 与 admin
 * `lib/data-center/technician-sql.ts` 的 `technicianCteSql` 是**两份独立副本**
 * （根 CLAUDE.md：禁止跨端共享代码目录，一致性靠字面量 snapshot 守护）。
 *
 * ## 为什么必须钉在一起
 *
 * 这两处是同一个业务口径的两个出口：staff 首页的人均派生指标、admin 数据中心人效板的
 * 人均派生指标。#285 修了 admin 侧，staff 侧当时**没同步** —— 于是同一天同一区间，
 * 两端人均业绩的分母差 14 人（staff 152 / admin 166，2026-09-24 生产实测），
 * staff 侧所有人均指标虚高 +9.2%。这正是「改一端忘另一端」的典型，所以补本守护。
 *
 * 守的是**归属规则的三个要件**，不是 SQL 全文（两端写法必然有差异：
 * Drizzle `sql` 模板 vs 原生 `pg.query` 字符串、`$n` vs `${}`）：
 *   1. `COALESCE(store_id, ds.store_id)` —— 直挂门店组织节点的人回收进该门店
 *   2. `anchor_market_id` 的 `CASE WHEN type='市场'` 两级兜底（自身 / 父节点）
 *   3. `LEFT JOIN stores ds ON ds.org_node_id = …` —— 回收用的那条 join
 *   4. 人池过滤：`skills && ARRAY['美容师','养生师']` ∩ hired_at/resigned_at 历史化
 *   5. 可见性二选一：门店分支走 store scope、无门店分支走市场锚
 */

const fs = require('node:fs')
const path = require('node:path')

const FILES = {
  staffDashboard: path.resolve(__dirname, '../../routes/mgmt-dashboard.js'),
  adminTechnicianSql: path.resolve(
    __dirname,
    '../../../../../fengyu-admin/src/lib/data-center/technician-sql.ts',
  ),
}

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

/** 抽出 `start` 到 `end` 之间的源码片段（end 不含） */
function extractSection(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker)
  const end = src.indexOf(endMarker, start)
  if (start < 0 || end < 0) {
    throw new Error(`未找到源码片段：${startMarker} → ${endMarker}`)
  }
  return src.slice(start, end)
}

/**
 * 归一化：抹掉两端必然不同的占位符与空白，只留下语义 token。
 * `$1` / `${endDate}` 都归成 `?`，多余空白压成单空格。
 */
function normalizeSql(sql) {
  return sql
    .replace(/\$\{[^}]+\}/g, '?')
    .replace(/\$\d+/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
}

describe('产能技师分母跨端字面量守护（#320）', () => {
  let staffSection
  let adminSection

  beforeAll(() => {
    staffSection = normalizeSql(
      extractSection(
        readFile(FILES.staffDashboard),
        'async function queryEmployeeCount(',
        '\n/**\n * 门店数（截面快照',
      ),
    )
    adminSection = normalizeSql(
      extractSection(
        readFile(FILES.adminTechnicianSql),
        'export function technicianCteSql(',
        '/** 产能技师总数',
      ),
    )
  })

  /** 抽取失败会让下面每条都通过（空串 include 恒真），所以先钉住抽取本身 */
  it('两端片段都成功抽到且非空', () => {
    expect(staffSection.length).toBeGreaterThan(200)
    expect(adminSection.length).toBeGreaterThan(200)
    expect(staffSection).toContain('technician_base')
    expect(adminSection).toContain('technician_base')
  })

  it('要件 1：两端都用 COALESCE 把直挂门店节点的人回收进该门店', () => {
    for (const [end, src] of [['staff', staffSection], ['admin', adminSection]]) {
      expect(src, `${end} 侧缺 COALESCE 回收`).toMatch(
        /COALESCE\(sw\.store_id, ds\.store_id\) AS store_id/,
      )
    }
  })

  it('要件 2：两端 anchor_market_id 都是「自身是市场 → 自身，否则父节点是市场 → 父节点」', () => {
    const pattern = /CASE WHEN o\.type = '市场' THEN o\.id WHEN op\.type = '市场' THEN op\.id ELSE NULL END AS anchor_market_id/
    for (const [end, src] of [['staff', staffSection], ['admin', adminSection]]) {
      expect(src, `${end} 侧锚定市场口径漂移`).toMatch(pattern)
    }
  })

  it('要件 3：两端都用同一条 join 回收门店（ds.org_node_id）', () => {
    for (const [end, src] of [['staff', staffSection], ['admin', adminSection]]) {
      expect(src, `${end} 侧缺回收 join`).toMatch(
        /LEFT JOIN stores ds ON ds\.org_node_id = sw\.org_node_id/,
      )
      expect(src, `${end} 侧缺 org_nodes 两级 join`).toMatch(
        /LEFT JOIN org_nodes o ON o\.id = sw\.org_node_id/,
      )
      expect(src).toMatch(/LEFT JOIN org_nodes op ON op\.id = o\.parent_id/)
    }
  })

  it('要件 4：两端人池过滤一致（技能标签 + hired_at/resigned_at 历史化）', () => {
    for (const [end, src] of [['staff', staffSection], ['admin', adminSection]]) {
      expect(src, `${end} 侧技能过滤漂移`).toMatch(
        /sw\.skills && ARRAY\['美容师','养生师'\]::text\[\]/,
      )
      expect(src).toMatch(/sw\.hired_at IS NOT NULL/)
      expect(src).toMatch(/sw\.hired_at::date <= \?/)
      expect(src).toMatch(/sw\.resigned_at IS NULL OR sw\.resigned_at::date > \?/)
      // 旧口径 is_resigned 实时快照不得回归
      expect(src, `${end} 侧不该再用 is_resigned 快照`).not.toMatch(/is_resigned/)
    }
  })

  it('要件 5：两端可见性都是「有门店走 store scope / 无门店走市场锚」二选一', () => {
    for (const [end, src] of [['staff', staffSection], ['admin', adminSection]]) {
      expect(src, `${end} 侧缺门店分支`).toMatch(/store_id IS NOT NULL AND/)
      expect(src, `${end} 侧缺市场锚分支`).toMatch(/store_id IS NULL AND/)
      // 两个分支必须是 OR 关系（AND 会把无门店的人整体排除，退回 #320 之前）
      expect(src).toMatch(/store_id IS NOT NULL AND[\s\S]*OR[\s\S]*store_id IS NULL AND/)
    }
  })

  /**
   * 反向守护：admin 侧那份注释声明「这是单源，别在别处再抄一份」。
   * 若 admin 内部又出现只按 `store_id` 过滤的技师查询，两端就会再次分叉 ——
   * #285 的 codex 谱系把这种情形判过 P0（同一数据中心两个板块差 14 人）。
   */
  it('admin 侧的技师查询只有 technician-sql.ts 这一份单源', () => {
    const efficiency = readFile(
      path.resolve(__dirname, '../../../../../fengyu-admin/src/actions/data-center/efficiency.ts'),
    )
    const sales = readFile(
      path.resolve(__dirname, '../../../../../fengyu-admin/src/actions/data-center/sales.ts'),
    )
    for (const [name, src] of [['efficiency.ts', efficiency], ['sales.ts', sales]]) {
      // 剥注释后再找：注释里为解释口径而提到技能标签是允许的
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
      const hits = code.match(/skills && ARRAY\['美容师','养生师'\]/g) ?? []
      expect(
        hits,
        `${name} 里又出现了独立的技师人池查询 —— 必须复用 lib/data-center/technician-sql.ts`,
      ).toEqual([])
    }
  })
})
