/**
 * 订单业绩归属日期一次性调整跨端字面量守护。
 *
 * staff routes/order.js 与 admin actions/orders.ts 各自保留独立实现；本测试锁定
 * FOR UPDATE、原始订单日前后 7 天窗口、毫秒精度 updated_at CAS 与 adjusted_at
 * 一次性判定，避免任一入口独自漂移。
 */

const fs = require('node:fs')
const path = require('node:path')

const FILES = {
  staffOrderJs: path.resolve(__dirname, '../../routes/order.js'),
  adminOrdersTs: path.resolve(__dirname, '../../../../../fengyu-admin/src/actions/orders.ts'),
}

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

function normalizeSql(sql) {
  return sql
    .replace(/\$\d+/g, '?')
    .replace(/\$\{[^}]+\}/g, '?')
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
    .trim()
}

function extractSection(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker)
  const end = src.indexOf(endMarker, start)
  if (start < 0 || end < 0) {
    throw new Error(`未找到源码片段：${startMarker} → ${endMarker}`)
  }
  return src.slice(start, end)
}

function extractBacktickStringContaining(src, marker) {
  const matches = src.matchAll(/`([^`]+)`/g)
  for (const match of matches) {
    if (match[1].includes(marker)) return match[1]
  }
  throw new Error(`未找到含 "${marker}" 的 backtick 字符串`)
}

describe('订单业绩归属日期一次性调整跨端字面量守护', () => {
  let sections
  let lockSqls
  let updateSqls

  beforeAll(() => {
    sections = {
      staff: extractSection(
        readFile(FILES.staffOrderJs),
        'async function updatePerformanceAttribution(ctx)',
        'async function detail(ctx)',
      ),
      admin: extractSection(
        readFile(FILES.adminOrdersTs),
        'export const updatePerformanceAttributionDate = withPermission(',
        'export const getOrderPayments = withAnyPermission(',
      ),
    }
    lockSqls = {
      staff: normalizeSql(extractBacktickStringContaining(sections.staff, 'performance_attribution_adjusted_at,')),
      admin: normalizeSql(extractBacktickStringContaining(sections.admin, 'performance_attribution_adjusted_at,')),
    }
    updateSqls = {
      staff: normalizeSql(extractBacktickStringContaining(sections.staff, "date_trunc('milliseconds', updated_at)")),
      admin: normalizeSql(extractBacktickStringContaining(sections.admin, "date_trunc('milliseconds', updated_at)")),
    }
  })

  test('锁单 SELECT 镜像一致并包含 FOR UPDATE', () => {
    expect(lockSqls.staff).toContain('FOR UPDATE')
    expect(lockSqls.admin).toContain('FOR UPDATE')
    expect(lockSqls.admin).toBe(lockSqls.staff)
  })

  test('两端均以原始订单上海自然日为基准限制前后 7 天', () => {
    for (const sql of Object.values(lockSqls)) {
      expect(sql).toContain("(sale_order_datetime AT TIME ZONE 'Asia/Shanghai')::date - 7")
      expect(sql).toContain("(sale_order_datetime AT TIME ZONE 'Asia/Shanghai')::date + 7")
    }
    for (const section of Object.values(sections)) {
      expect(section).toMatch(/targetDate < locked\.min_performance_date \|\| targetDate > locked\.max_performance_date/)
    }
  })

  test("更新 SQL 镜像一致并使用 date_trunc('milliseconds', ...) CAS", () => {
    const casPredicate = "date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', ?::timestamptz)"
    expect(updateSqls.staff).toContain(casPredicate)
    expect(updateSqls.admin).toContain(casPredicate)
    expect(updateSqls.admin).toBe(updateSqls.staff)
  })

  test('两端均以 adjusted_at 锁定一次性调整机会', () => {
    for (const section of Object.values(sections)) {
      expect(section).toMatch(/if \(locked\.performance_attribution_adjusted_at\)/)
    }
    for (const sql of Object.values(updateSqls)) {
      expect(sql).toContain('performance_attribution_adjusted_at = NOW()')
      expect(sql).toContain('AND performance_attribution_adjusted_at IS NULL')
    }
  })
})
