import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { DIGEST_PATTERN } from "@/components/analyst-error-state"

/**
 * digest 白名单的**真正跨端守护**（#316）。
 *
 * 这条正则在两个独立部署的站点各有一份**刻意的副本**（跨端共享目录已 veto，见根 CLAUDE.md）：
 *   ├── fengyu-analyst/src/components/analyst-error-state.tsx
 *   └── fengyu-admin/src/app/(main)/error.tsx
 *
 * ## 为什么不能只在各端断言自己的字面量
 *
 * 初稿两侧各有一条 `expect(本端导出).toBe("本端硬编码字符串")` —— 闸门 2 codex 指出那**不是**
 * 跨端守护，有两个双绿反例：
 *
 * 1. 只改 admin 正则、顺手把 admin 自己的期望字符串一起改了 → 两端都绿，但已经漂移；
 * 2. 两边**同时**误加 `m` flag → `.source` 逐字不变，两套测试双绿，
 *    但 `m` 让 `^`/`$` 匹配行首行尾，`"123\npostgresql_fengyu_fengyu123_localhost_5432"`
 *    这种多行串会整串放行（已实测：同 source 下普通正则拒绝、`m` 正则接受）。
 *
 * 所以这里**直接读 admin 的源文件**取它那一行的字面量，与 analyst 的实际正则比 `toString()`
 * （含 flags），再补一条换行反例。解析策略与
 * `fengyu-admin/src/lib/__tests__/error-codes-cross-end.test.ts` 同源：
 * 跨站点没法 import（两套 tsconfig / 两个 Next 应用），只能按文件读取 + 正则提取。
 */

const ADMIN_ERROR_PAGE = path.resolve(
  __dirname,
  "../../../../fengyu-admin/src/app/(main)/error.tsx",
)

/** 从 admin 源码里抠出 `const NEXT_AUTO_DIGEST_RE = /.../` 那一行的正则字面量（含 flags）。 */
function readAdminPatternLiteral(): string {
  const src = readFileSync(ADMIN_ERROR_PAGE, "utf8")
  const m = src.match(/const NEXT_AUTO_DIGEST_RE\s*=\s*(\/.*\/[a-z]*)\s*$/m)
  if (!m) {
    throw new Error(
      `未能在 ${ADMIN_ERROR_PAGE} 中找到 NEXT_AUTO_DIGEST_RE 的定义。` +
        `若 admin 侧重命名或换了写法，请同步更新本测试的提取正则——` +
        `别直接删掉这条守护，那会让两端重新自由漂移。`,
    )
  }
  return m[1]
}

describe("digest 白名单跨端一致性（analyst ↔ admin）", () => {
  it("两端的正则**含 flags** 逐字一致", () => {
    expect(DIGEST_PATTERN.toString()).toBe(readAdminPatternLiteral())
  })

  it("规范字面量锚定——两端同时改坏时这条仍会红", () => {
    // 上一条只保证「两边一样」，这条保证「一样的那个是对的」。缺了它，
    // 两端同步改成一个错的正则仍然双绿。
    expect(DIGEST_PATTERN.toString()).toBe("/^\\d{1,10}(?:@E\\d{1,9})?$/")
  })

  it("⚠️ 没有 m flag——多行 digest 不得整串放行", () => {
    // 这条是上面「含 flags 比对」的语义兜底：即便将来提取逻辑失效，行为层面仍被钉住。
    expect(DIGEST_PATTERN.flags).toBe("")
    expect(DIGEST_PATTERN.test("123\npostgresql_fengyu_fengyu123_localhost_5432")).toBe(false)
    expect(DIGEST_PATTERN.test("123\n")).toBe(false)
    expect(DIGEST_PATTERN.test("postgresql://x\n123")).toBe(false)
  })

  it("合法编号仍然放行（确认守卫没把自己锁死）", () => {
    expect(DIGEST_PATTERN.test("1234567890")).toBe(true)
    expect(DIGEST_PATTERN.test("42@E404")).toBe(true)
  })
})
