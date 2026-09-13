import { test, expect } from '@playwright/test'

test.describe('营业额分配列表', () => {
  test('渲染页面标题', async ({ page }) => {
    await page.goto('/allocations')
    await expect(page.getByRole('heading', { name: '营业额分配' })).toBeVisible()
  })

  test('表格列头完整', async ({ page }) => {
    await page.goto('/allocations')
    // 销售提成默认 Tab 已下沉到「回款维度」(SaleAllocationTable)：
    // 列为 回款(类型+金额) / 顾客 / 门店 / 订单号 / 分配状态 / 到账时间 / 操作，
    // 不再有单独的「订单金额」列（仅保留在 xlsx 导出列）。
    await expect(page.getByRole('columnheader', { name: '订单号' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '分配状态' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '顾客' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '回款' })).toBeVisible()
  })

  test('分配状态筛选改写 URL 且跨 Tab 保留', async ({ page }) => {
    await page.goto('/allocations')

    const statusSelect = page.locator('select').first()
    await statusSelect.selectOption('待分配')
    await expect(page).toHaveURL(/allocStatus=%E5%BE%85%E5%88%86%E9%85%8D|allocStatus=待分配/)

    // 切到服务提成 Tab，allocStatus 应保留
    await page.getByRole('tab', { name: '服务提成' }).click()
    await expect(page).toHaveURL(/tab=service/)
    await expect(page).toHaveURL(/allocStatus=%E5%BE%85%E5%88%86%E9%85%8D|allocStatus=待分配/)
    await expect(page.getByRole('columnheader', { name: '服务单号' })).toBeVisible()
  })

  test('销售提成支持款项发生日期，服务提成仍固定按服务日期', async ({ page }) => {
    await page.goto('/allocations')

    // 缺省口径是款项归属日期，且不写进 URL
    await expect(page.getByRole('combobox', { name: '日期口径' })).toHaveValue('attribution')
    await expect(page.getByLabel('款项归属开始日期')).toBeVisible()
    await expect(page).not.toHaveURL(/dateBasis=/)

    await page.getByRole('combobox', { name: '日期口径' }).selectOption('payment')
    await expect(page).toHaveURL(/dateBasis=payment/)
    await expect(page.getByLabel('款项发生开始日期')).toBeVisible()

    await page.getByRole('tab', { name: '服务提成' }).click()
    await expect(page.getByRole('combobox', { name: '日期口径' })).toHaveCount(0)
    await expect(page.getByLabel('服务开始日期')).toBeVisible()
  })
})
