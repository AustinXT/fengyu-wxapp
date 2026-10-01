/** #469：门店报货数量的失焦中文反馈与真实提交闸，连接 dev 库。 */
import { test, expect } from '@playwright/test'
import { BASE, INVT_ACCOUNTS, INVT_PASS, NS, TOPO, login, psql, sqlStr } from './_helpers/env'
import { labelled, openOperation, pickSku, selectByLabel } from './_helpers/ui'

test.setTimeout(180_000)

test('INV-91：非法数量失焦有中文提示且不能提交，修正后能建单', async ({ page }) => {
  const skuName = psql("SELECT product_name FROM inventory_skus WHERE is_active=true AND product_name LIKE 'INVT-%' ORDER BY created_at DESC LIMIT 1")
  expect(skuName, 'dev 缺少可用库存测试 SKU').not.toBe('')
  const remark = `${NS}-数量失焦-${Date.now()}`
  const count = () => Number(psql(`SELECT count(*) FROM inventory_docs WHERE remark=${sqlStr(remark)}`))

  await login(page, INVT_ACCOUNTS.ADM.phone, INVT_PASS)
  await openOperation(page, 'store', '门店报货')
  await selectByLabel(page, '报货门店', { contains: TOPO.STORE_A_NAME })
  await selectByLabel(page, '所属市场', { contains: TOPO.MARKET_NAME })
  await pickSku(page.getByRole('combobox', { name: '选择库存商品', exact: true }).first(), skuName)
  const quantity = labelled(page, '数量').locator('input').first()
  await labelled(page, '备注').locator('textarea, input').first().fill(remark)
  const submit = page.locator('form').getByRole('button', { name: '创建门店报货单' })
  expect(count()).toBe(0)
  for (const [raw, message] of [['-1', '不能小于'], ['99999999999', '不能大于'], ['1.005', '步长']] as const) {
    await quantity.fill(raw)
    await quantity.blur()
    await expect(labelled(page, '数量').getByRole('alert')).toContainText(message)
    await submit.click()
    expect(count(), `${raw} 不应落库`).toBe(0)
  }
  await quantity.fill('1.01')
  await quantity.blur()
  await expect(labelled(page, '数量').getByRole('alert')).toHaveCount(0)
  await submit.click()
  await expect(page.locator('[data-sonner-toast]').first()).toContainText('门店报货单已创建')
  expect(count()).toBe(1)
  console.log(`[INV-91] ${BASE}/inventory/operations/store 负数/超上限/非法步长拦截，合法建单成功`)
})
