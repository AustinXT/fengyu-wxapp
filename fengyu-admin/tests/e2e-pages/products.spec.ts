import { test, expect } from '@playwright/test'

test.describe('商品列表', () => {
  test('渲染页面标题和操作按钮', async ({ page }) => {
    await page.goto('/products')
    await expect(page.getByRole('heading', { name: '商品管理' })).toBeVisible()
    await expect(page.getByText('新增商品')).toBeVisible()
    await expect(page.getByRole('button', { name: '品项分类' })).toBeVisible()
  })

  test('筛选器完整', async ({ page }) => {
    await page.goto('/products')
    await expect(page.getByPlaceholder(/搜索/)).toBeVisible()
    expect(await page.locator('select').count()).toBeGreaterThanOrEqual(1)
  })

  test('表格列头完整', async ({ page }) => {
    await page.goto('/products')
    await expect(page.getByRole('columnheader', { name: /商品名称/ })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: /标价/ })).toBeVisible()
  })

  test('品项分类导航', async ({ page }) => {
    await page.goto('/products')
    await page.getByRole('button', { name: '品项分类' }).click()
    await expect(page).toHaveURL(/\/products\/categories/)
  })

  test('编辑后返回时保留二级分类和完整列表上下文', async ({ page }) => {
    await page.goto('/products?status=all&size=50')
    const firstRow = page.locator('tbody tr').first()
    const editButton = firstRow.getByRole('button', { name: '编辑' })
    test.skip(await editButton.count() === 0, '测试库没有可编辑商品')

    const categoryText = (await firstRow.locator('td').nth(1).innerText()).trim()
    const [kind, category] = categoryText.split('/').map((part) => part.trim())
    test.skip(!kind || !category || category === '—', '测试商品没有二级分类')

    await page.getByRole('button', { name: '品项筛选' }).click()
    await page.getByRole('button', { name: kind, exact: true }).hover()
    await page.getByRole('button', { name: category, exact: true }).click()
    await expect(page).toHaveURL(/category=/)
    await expect(page).toHaveURL(/kind=/)

    const source = new URL(page.url())
    await page.locator('tbody tr').first().getByRole('button', { name: '编辑' }).click()
    const detail = new URL(page.url())
    expect(detail.searchParams.get('returnTo')).toBe(`${source.pathname}${source.search}`)

    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByText('保存成功')).toBeVisible()
    await page.getByRole('button', { name: '返回', exact: true }).click()

    await expect(page).toHaveURL(`${source.pathname}${source.search}`)
    await expect(
      page.getByRole('button').filter({ hasText: `${kind} / ${category}` }).first(),
    ).toBeVisible()
  })
})

test.describe('品项分类', () => {
  test('渲染页面标题', async ({ page }) => {
    await page.goto('/products/categories')
    await expect(page.getByRole('heading', { name: /品项分类/ })).toBeVisible()
  })

  test('product_kind Tab 完整（4 个标准品类）', async ({ page }) => {
    await page.goto('/products/categories')
    // 「组合套餐」已于 2026-04-10 baseline reset 从 product_kind 枚举移除（改由 products.is_bundle 表达）
    await expect(page.getByRole('tab', { name: /护理项目/ })).toBeVisible()
    await expect(page.getByRole('tab', { name: /家居产品/ })).toBeVisible()
    await expect(page.getByRole('tab', { name: /充值卡/ })).toBeVisible()
    await expect(page.getByRole('tab', { name: /体验卡/ })).toBeVisible()
  })

  test('Tab 切换正常', async ({ page }) => {
    await page.goto('/products/categories')
    await page.getByRole('tab', { name: /护理项目/ }).click()
    await expect(page.getByRole('tab', { name: /护理项目/ })).toHaveAttribute('aria-selected', 'true')
  })

  test('新增分类按钮可见', async ({ page }) => {
    await page.goto('/products/categories')
    // 按钮已更名为「新增二级分类」
    await expect(page.getByRole('button', { name: /新增二级分类/ })).toBeVisible()
  })
})

test.describe('新增商品', () => {
  test('渲染返回按钮和表单', async ({ page }) => {
    await page.goto('/products/create')
    await expect(page.getByRole('button', { name: /返回/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: /新增商品/ })).toBeVisible()
  })

  test('表单分组完整', async ({ page }) => {
    await page.goto('/products/create')
    await expect(page.getByText('基本信息')).toBeVisible()
    await expect(page.getByText(/价格/)).toBeVisible()
  })

  test('提交按钮可见', async ({ page }) => {
    await page.goto('/products/create')
    await expect(page.getByRole('button', { name: /创建商品/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /取消/ })).toBeVisible()
  })
})
