import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')

describe('服务单详情核销次数展示', () => {
  const wxml = fs.readFileSync(
    path.join(ROOT, 'packageService/service-detail/service-detail.wxml'),
    'utf-8',
  )

  test('所有核销项目均展示本次核销次数和完整卡次数明细', () => {
    expect(wxml).toContain("本次核销 {{item.sessionCount == null ? '—' : item.sessionCount}}")
    expect(wxml).toContain("剩余 {{item.remainingSessions == null ? '—' : item.remainingSessions}}")
    expect(wxml).toContain("已付 {{item.paidSessions == null ? '—' : item.paidSessions}}")
    expect(wxml).toContain("共 {{item.totalSessions == null ? '—' : item.totalSessions}}")
  })

  test('单次项目不再被疗程总次数条件隐藏', () => {
    expect(wxml).not.toContain('wx:if="{{item.totalSessions > 1}}"')
    expect(wxml).toMatch(/<text class="item-sessions">[\s\S]*?本次核销[\s\S]*?<\/text>/)
  })
})
