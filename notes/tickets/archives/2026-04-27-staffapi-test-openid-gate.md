# staffApi _testOpenid 无 ALLOW_TEST_OPENID 环境变量门控

| 字段 | 值 |
|------|-----|
| 来源 | audit-CC4-auth.md P0-CC4-09（v2 新发现） |
| 优先级 | P0 |
| 修复成本 | S（10 min） |
| 影响 | staffApi 全路由越权 — 命中 real.md #6 |
| 状态 | ✅ 已修复 |

## 问题描述

staffApi `middleware/auth.js:103` 直接读取 `_testOpenid` 覆盖 OPENID，**无任何环境变量门控**：

```js
// staffApi/middleware/auth.js:103-104 — 当前代码（无保护）
const testOpenid = ctx.event.payload?._testOpenid || ctx.event._testOpenid
const effectiveOpenid = testOpenid || OPENID
```

任何调用者可在 payload 中传入 `_testOpenid` 伪造任意员工身份，越权访问全部 staffApi 业务路由。

## 对比 clientApi（已有正确保护）

```js
// clientApi/middleware/auth.js:22-27 — 正确模式
// 测试模式: 仅在显式开启时允许通过 _testOpenid 参数覆盖
if (process.env.ALLOW_TEST_OPENID === 'true') {
  const testOpenid = ctx.event.payload?._testOpenid || ctx.event._testOpenid
  if (testOpenid) effectiveOpenid = testOpenid
}
```

clientApi 用 `process.env.ALLOW_TEST_OPENID === 'true'` 门控，生产环境不设此变量即自动关闭。

## 修复方案

参照 clientApi，在 staffApi `middleware/auth.js` 加入同等门控：

```js
// 修复后
const { OPENID } = cloud.getWXContext()

// 测试模式: 仅在显式开启时允许通过 _testOpenid 参数覆盖（生产环境不设此变量）
let effectiveOpenid = OPENID
if (process.env.ALLOW_TEST_OPENID === 'true') {
  const testOpenid = ctx.event.payload?._testOpenid || ctx.event._testOpenid
  if (testOpenid) effectiveOpenid = testOpenid
}
```

## 验证要点

1. 生产环境 staffApi 不设 `ALLOW_TEST_OPENID` 环境变量
2. 传入 `_testOpenid` 时应被忽略（使用真实 OPENID）
3. 仅在开发/测试环境显式设置 `ALLOW_TEST_OPENID=true` 后才生效
4. 现有测试如果依赖 `_testOpenid`，需确认测试环境有该变量（或 mock `process.env`）

## 关联

- audit-CC4-auth.md §P0-CC4-09、§P1-CC4-20
- SUMMARY.md Top 10 P0 #2
- Epic E1（payNotify 安全收官 + _testOpenid 门控）
- real.md #6（OPENID 认证不可被用户侧覆盖）
