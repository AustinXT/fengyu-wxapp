# Ticket: link-20 "批量发放" 按钮 dialog 内外选择器歧义（README 已知）

| 字段 | 值 |
|------|-----|
| 生成日期 | 2026-05-18 |
| 实施状态 | 待修 spec |
| 优先级 | **P3**（纯 spec UI selector 问题；不阻塞业务）|
| 端 | tests/e2e-chains |
| 修复成本 | **S**（一行 locator 改写）|
| 来源 | 2026-05-17 README §1.B link-20 已标注；2026-05-18 跑批复现 |
| 类别 | spec UI 选择器（非 admin bug）|

---

## 0 一句话

`/coupons/[template_id]/grant` 页有 2 个 "批量发放" 按钮：①外层"打开 dialog"触发按钮、②dialog 内部"提交发放"按钮。spec 用 `getByRole('button', { name: '批量发放' }).last()` 试图取第二个，但 dialog backdrop 拦截 click，重试 30+ 次后超时。

---

## 1 README 已写的修复

> "**fix spec**：在 `locator('dialog[open]')` 作用域内找提交按钮"

---

## 2 决策点

只有 1 个合理方案——按 README 写法改：

```ts
// 旧
await page.getByRole('button', { name: '批量发放' }).last().click()

// 新
const dialog = page.locator('dialog[open]')  // or 'div[role="dialog"]'
await dialog.getByRole('button', { name: '批量发放' }).click()
```

---

## 3 我需要你判断的

**Q1**：是否直接让我改 spec，不用单独 ticket 走流程？这个修复纯 spec 工程，admin 代码不动。

---

## 4 关联引用

- `tests/e2e-chains/link-20-coupon-batch-issue.spec.ts`
