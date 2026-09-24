"use client"

import { useEffect, useRef, useTransition } from "react"
import { useRouter } from "next/navigation"

/**
 * 两个 error boundary 共用的错误态卡片。
 *
 * 抽出来是因为 `(main)/error.tsx` 与 `app/error.tsx` 的**外壳不同、内容相同**：
 * 前者被 `AnalystShell` 包住（左侧导航还在，用户能切到别的看板），
 * 后者是 `(main)/layout.tsx` 自己挂了、外壳渲染不出来，只能整页居中。
 * 内容两处逐字一致，别让它们各自演化（#316）。
 */

/**
 * Next 自动生成的错误编号形态：`stringHash(message + stack)`（无符号 32 位十进制），
 * 15.5 起对带 `__NEXT_ERROR_CODE` 的错误会追加 **`@E<数字>`**（`lib/error-telemetry-utils.js`
 * 的 `createDigestWithErrorCode`；错误码注册表目前是 3~4 位，`\d{1,9}` 留足余量）。
 *
 * ⚠️ 不宣称覆盖 Next 的**全部** digest 形态：拼接函数原样追加 `__NEXT_ERROR_CODE`，
 * 15.5.20 里还存在 `TurbopackInternalError` 这种非数字码（理论形态 `42@TurbopackInternalError`）。
 * 那类会被本白名单拒掉 —— **fail-closed，只损失客服定位、不泄漏**，且它属构建链路、
 * 通常进不到业务 RSC 边界。别为了"覆盖全"把后缀放回字母通配。
 *
 * ⚠️ **只有这种形态才允许渲染**，因为 `digest` 是这个组件唯一会打到页面上的外来字符串。
 * 生产环境 Next 会脱敏 `error.message`，但**不会碰 `digest`**——上游若把完整业务/技术文案
 * 塞进它（admin 侧实测过 `INVALID_STATE: CLIENT_SECRET is not configured`），
 * 白名单就是唯一的闸门。
 *
 * ⚠️ **后缀必须锁死成 `@E<数字>`，别放宽成 `@[A-Za-z][\w-]*`**（本 PR 初稿的写法，闸门 1 揪出）：
 * `[\w-]` 含 `_` 与 `-`，于是任何写成 snake_case / kebab-case 的技术串都会整串放行——
 * 实测 `1@ECONNREFUSED_127-0-0-1_5432`、`0@postgresql_fengyu_fengyu123_localhost_5432`
 * 全部通过。那样"过滤"掉的只是标点，不是语义。同型教训见 memory
 * `project-url-sanitizer-case-sensitivity`（整条加 `/i` 会 fail-open）。
 *
 * ⚠️ 这条正则在 `fengyu-admin/src/app/(main)/error.tsx` 有一份**刻意的副本**
 * （跨端共享目录已 veto）。**两侧各有一条字面量锚定测试钉住同一个 source**，
 * 改一边不同步另一边时两边都会红。
 */
const NEXT_AUTO_DIGEST_RE = /^\d{1,10}(?:@E\d{1,9})?$/

/**
 * 导出给测试做跨端锚定。
 *
 * ⚠️ 导的是**整个正则**而不是 `.source`：`.source` 不含 flags，
 * 两边同时误加 `m` 后 `.source` 逐字不变、两套测试双绿，但 `m` 让 `^`/`$` 匹配行首行尾，
 * `"123\npostgresql_fengyu_fengyu123_..."` 这种多行串就会整串放行（#316 闸门 2 codex 揪出，已实测）。
 */
export const DIGEST_PATTERN = NEXT_AUTO_DIGEST_RE

/**
 * 根段错误页的「真出口」。
 *
 * ⚠️ 默认值**不能写 `/`**：`app/page.tsx` 是 `redirect("/dashboard")`，而 `/dashboard`
 * 就在挂掉的 `(main)` 段里——绕一圈又回到同一张错误页，是假出口的另一种形态（#316 闸门 2 揪出）。
 * 这里与 `AnalystShell` 用同一个默认值，保持站内一致。
 */
const ADMIN_ORIGIN = process.env.NEXT_PUBLIC_ADMIN_ORIGIN || "http://localhost:3000"

export function AnalystErrorState({
  digest,
  reset,
  layout,
}: {
  digest?: string
  reset: () => void
  /** `section` = 外壳还在（段级）；`page` = 外壳也挂了，整页居中 */
  layout: "section" | "page"
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const headingRef = useRef<HTMLHeadingElement>(null)

  // 错误发生后整棵子树被替换，焦点会留在原处（或掉到 body）——键盘 / 读屏用户拿不到落点。
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  /**
   * ⚠️ **光调 `reset()` 救不回 server component 的错误。**
   *
   * Next 15 的 `reset` 实现就一行 `setState({ error: null })`
   * （`next/dist/client/components/error-boundary.js`，全文无 `router.refresh` / 无 refetch）。
   * 清掉 error state 后重渲染的是**同一份已经出错的 RSC payload**，`use(rsc)` 会同步重抛，
   * 边界立刻再接住——画面纹丝不动，DB 恢复了也不会自愈，只能整页刷新。
   *
   * 而本站三个看板与 `(main)/layout.tsx` 全是 async server component，无一例外走这条路径。
   * 所以必须先 `router.refresh()` 丢弃 router cache 重取 RSC，再 `reset()` 清边界状态。
   *
   * 顺带用 `useTransition` 的 `pending` 给按钮加禁用态：DB 已经不健康时，
   * 每次点击都会重跑 `getSession()` 的两次查库，无节流的连点只会继续加压。
   */
  const retry = () => {
    startTransition(() => {
      router.refresh()
      reset()
    })
  }

  // ⚠️ `digest` 的 TS 类型是 `string | undefined`，但运行时不保证。若上游给了个
  //    `{ toString() {...} }`，`RE.test()` 的隐式 String() 会让它通过，随后
  //    React 渲染对象时抛 "Objects are not valid as a React child"——**错误边界自己崩了**，
  //    段级会冒泡到根段、根段会冒回 Next 内建页，正好退回 #316 修复前的原状。
  const showDigest = typeof digest === "string" && NEXT_AUTO_DIGEST_RE.test(digest)

  return (
    <div
      className={
        layout === "page"
          ? "flex min-h-screen items-center justify-center bg-[var(--background)] px-6"
          : "flex min-h-[60vh] items-center justify-center px-6"
      }
    >
      <section className="w-full max-w-md rounded-lg border border-[var(--border)] bg-white p-6 text-center">
        {/* role="alert" 只包文本，**不包交互控件**：它隐含 aria-live="assertive" + aria-atomic，
            把按钮圈进去会让部分屏幕阅读器把「重试」当静态文本一口气念掉，用户听不出那是可聚焦的。 */}
        <div role="alert">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-lg font-semibold text-neutral-950 outline-none"
          >
            数据加载失败
          </h1>
          <p className="mt-2 text-sm text-neutral-500">
            {/* 刻意不回显 error.message：dev 下它可能是原始 SQL / 连接串（含口令），
                prod 下 Next 已脱敏，两边都不该把它当用户文案。 */}
            多数是数据库瞬时抖动，点「重试」可重新取数；持续失败请联系管理员。
          </p>
          {showDigest && (
            <p className="mt-3 break-all font-mono text-xs text-neutral-400">错误编号：{digest}</p>
          )}
        </div>

        <div className="mt-5 flex justify-center gap-3">
          <button
            type="button"
            onClick={retry}
            disabled={pending}
            className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? "重试中…" : "重试"}
          </button>
          {layout === "page" && (
            /* ⚠️ 用整文档导航（裸 `<a>`）而不是 `next/link`：走到这一层说明
               `(main)/layout.tsx` 已经挂了，软导航会复用同一棵坏客户端树。
               ⚠️ 也刻意**不**指向 `/dashboard`——那就在 `(main)` 段里，点了必然再跑一遍
               同一个 layout、转回同一张错误页，是个假出口。指向 admin 首页才是真出口。 */
            <a
              href={ADMIN_ORIGIN}
              className="rounded-md border border-[var(--border)] px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
            >
              返回管理后台
            </a>
          )}
        </div>
      </section>
    </div>
  )
}
