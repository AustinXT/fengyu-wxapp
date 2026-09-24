import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '../..')

describe('服务单创建备注输入', () => {
  test('van-field 自定义备注按字符串 detail 写入页面状态', () => {
    const tsContent = fs.readFileSync(
      path.join(ROOT, 'packageService/service-create/service-create.ts'),
      'utf-8',
    )
    const wxmlContent = fs.readFileSync(
      path.join(ROOT, 'packageService/service-create/service-create.wxml'),
      'utf-8',
    )

    expect(wxmlContent).toMatch(/<van-field[\s\S]*bind:change="onRemarkChange"/)
    expect(wxmlContent).not.toMatch(/<van-field[\s\S]*extra-event-params/)
    expect(tsContent).toContain("this.setData({ remark: (e.detail as unknown as string) ?? '' });")
    expect(tsContent).not.toContain('this.setData({ remark: e.detail.value });')
  })

  test('来源订单备注仅作为卡片只读信息，不写入服务备注', () => {
    const tsContent = fs.readFileSync(path.join(ROOT, 'packageService/service-create/service-create.ts'), 'utf-8')
    const wxmlContent = fs.readFileSync(path.join(ROOT, 'packageService/service-create/service-create.wxml'), 'utf-8')

    expect(tsContent).toContain('orderRemark: item.orderRemark?.trim() || null')
    expect(tsContent).toContain('sourceOrderRemarks: collectSourceOrderRemarks(group.sourceItems)')
    expect(wxmlContent).toContain('订单备注：{{remarkItem.orderRemark}}')
    expect(tsContent).not.toMatch(/remark:\s*(?:i|item|preloadedItem)\.orderRemark/)
  })
})
