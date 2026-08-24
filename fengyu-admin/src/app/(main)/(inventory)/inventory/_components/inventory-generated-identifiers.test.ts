import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8')
}

describe('进销存编号与实体引用表单守卫', () => {
  it('库存商品和福利方案只展示系统编号，不把编号提交给后端', () => {
    const skus = source('src/app/(main)/(inventory)/inventory/_components/inventory-skus-page.tsx')
    const promotions = source('src/app/(main)/(inventory)/inventory/_components/inventory-promotions-page.tsx')

    expect(skus).toContain('保存后由系统自动生成')
    expect(skus).not.toContain("setField('productCode'")
    expect(skus).not.toMatch(/productCode:\s*form\./)
    expect(promotions).toContain('保存后由系统自动生成')
    expect(promotions).not.toContain("setField('planNo'")
    expect(promotions).not.toMatch(/planNo:\s*form\./)
  })

  it('销售商品组成、员工购和自采入库只能通过选项引用实体', () => {
    const compositions = source('src/app/(main)/(inventory)/inventory/_components/inventory-sku-mappings-page.tsx')
    const operations = source('src/app/(main)/(inventory)/inventory/_components/inventory-operations-page.tsx')

    expect(compositions).not.toContain('<datalist')
    expect(compositions).not.toMatch(/\slist=/)
    expect(compositions).not.toContain('输入或选择销售 SKU ID')
    expect(compositions).not.toContain('输入或选择库存 SKU ID')
    expect(operations).not.toContain('购买员工 ID')
    expect(operations).not.toContain('员工编号')
    expect(operations).not.toContain('setSupplierName')
    expect(operations).toContain('请选择员工')
    expect(operations).toContain('请选择供应商')
  })

  it('员工小程序库存业务继续使用产品、批次和门店选择器', () => {
    const staffForm = source('../fengyu-staff/miniprogram/packageMy/inventory/form.wxml')

    expect(staffForm).toContain('bindchange="onSkuChange"')
    expect(staffForm).toContain('bindchange="onLotChange"')
    expect(staffForm).toContain('bindchange="onStoreChange"')
    expect(staffForm).not.toMatch(/<input[^>]+(?:sku|编号|ID)/i)
  })
})
