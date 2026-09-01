# fengyu-admin 测试导航

admin 的所有测试统一收敛到本目录，按"测试粒度 + 技术栈"分为四类。Vitest 单元测试**与源码同目录**（`src/**/*.test.{ts,tsx}`），本目录只放 setup + 三个 E2E 子目录。

## 目录

| 子目录 | 技术栈 | 粒度 | 何时跑 |
|---|---|---|---|
| `setup.ts` | Vitest | 全局 setup（cleanup RTL + happy-dom） | 由 `vitest.config.ts` 自动加载 |
| `e2e-actions/` | bun child + 直调 Server Action | 单 action 全链路 smoke（含真 PG） | 手工 / 改 action 后冒烟 |
| `e2e-pages/` | Playwright（主 `playwright.config.ts`） | 单页 UI 渲染断言 + 视觉快照 | CI / `bun run test:e2e` |
| `e2e-chains/` | Playwright（`e2e-chains/playwright.manual.config.ts`） | 跨页跨角色有状态业务链路（link-1~23，会计恒等式/状态机校验） | `bun run test:e2e:manual` / 跑 loop 时 |

## 运行命令

```bash
# 在 fengyu-admin/ 内执行
bun run test                # Vitest 单元（src/**/*.test.{ts,tsx} + tests/setup.ts）
bun run test:coverage       # 同上 + 覆盖率（含 src/lib + src/actions + src/cron）
bun run test:e2e            # Playwright e2e-pages（自动套件，需 dev server）
bun run test:e2e:manual     # Playwright e2e-chains（headed manual chains）
bun run test:visual         # Playwright e2e-pages/visual（视觉回归）
bun run test:all            # vitest + playwright（不含 manual chains）

# Server Action smoke（直接走 bun，不进 Playwright）
bun tests/e2e-actions/smoke-record-payment.mjs
bun tests/e2e-actions/cleanup.mjs

# 进销存链路冒烟门禁（正向全链 + 退货双链 + 调货/自采链；本地 docker 一次性库，逢跑即建）
bun run test:e2e:inventory
```

## 入口文档

- **`e2e-chains/README.md`** —— 23 条业务链路的完整操作手册（fixtures、psql 模式、上下文传递）
- **`e2e-actions/smoke-record-payment.mjs`** —— bun smoke 的入口范例
- **顶层 `playwright.config.ts`** —— testDir 指向 `./tests/e2e-pages`
- **`e2e-chains/playwright.manual.config.ts`** —— testDir 指向 `.`（自身），fullyParallel=false / headless=false / workers=1
