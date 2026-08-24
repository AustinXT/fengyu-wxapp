import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')

describe('顾客详情固定两排页签', () => {
  test('9 个页签全部由固定网格展示，默认导航不再横向滚动', () => {
    const wxml = fs.readFileSync(
      path.join(ROOT, 'packageCustomer/customer-detail/customer-detail.wxml'),
      'utf-8',
    )
    const wxss = fs.readFileSync(
      path.join(ROOT, 'packageCustomer/customer-detail/customer-detail.wxss'),
      'utf-8',
    )

    expect(wxml).toContain('wx:for="{{tabTitles}}"')
    expect(wxml).toContain('bindtap="onTabTap"')
    expect(wxml).toContain('nav-class="customer-tabs__native-nav"')
    expect(wxml).not.toMatch(/<van-tabs[^>]*\sscrollable(?:=|\s|>)/)
    expect(wxss).toMatch(/\.customer-tabs\s*\{[^}]*grid-template-columns:\s*repeat\(5,/s)
    expect(wxss).toMatch(/\.customer-tabs__native-nav\s*\{[^}]*display:\s*none/s)
  })
})
