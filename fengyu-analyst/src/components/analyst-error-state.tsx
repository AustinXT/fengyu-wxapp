"use client"

/**
 * 两个 error boundary 共用的错误态卡片。
 *
 * 抽出来是因为 `(main)/error.tsx` 与 `app/error.tsx` 的**外壳不同、内容相同**：
 * 前者被 `AnalystShell` 包住（左侧导航还在，用户能切到别的看板），
 * 后者是 `(main)/layout.tsx` 自己挂了、外壳渲染不出来，只能整页居中。
 * 内容两处逐字一致，别让它们各自演化（#316）。
 */

/**
 * Next 自动生成的错误编号形态：`stringHash(message + stack).toString()`
 * （无符号 32 位十进制），15.5 起对带 `__NEXT_ERROR_CODE` 的错误会追加 `@E<码>`。
 *
 * ⚠️ **只有这种形态才允许渲染。** `digest` 字段也可能被上游塞进完整的业务/技术文案
 * （admin 侧实测过 `INVALID_STATE: CLIENT_SECRET is not configured` 这种），
 * 原样打到页面上就会把技术细节泄漏给用户——生产环境 Next 会脱敏 `error.message`，
 * 但**不会碰 `digest`**，白名单是这一侧唯一的闸门。
 * 同源实现见 `fengyu-admin/src/app/(main)/error.tsx`（那边由 #133 收敛而来）。
 */
const NEXT_AUTO_DIGEST_RE = /^\d{1,10}(?:@[A-Za-z][\w-]*)?$/

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
  const showDigest = digest !== undefined && NEXT_AUTO_DIGEST_RE.test(digest)

  return (
    <div
      className={
        layout === "page"
          ? "flex min-h-screen items-center justify-center bg-[var(--background)] px-6"
          : "flex min-h-[60vh] items-center justify-center px-6"
      }
    >
      <section
        role="alert"
        className="w-full max-w-md rounded-lg border border-[var(--border)] bg-white p-6 text-center"
      >
        <h1 className="text-lg font-semibold text-neutral-950">数据加载失败</h1>
        <p className="mt-2 text-sm text-neutral-500">
          {/* 刻意不回显 error.message：dev 下它可能是原始 SQL / 连接串（含口令），
              prod 下 Next 已脱敏成 digest，两边都不该把它当用户文案。 */}
          多数是数据库瞬时抖动，点「重试」通常就能恢复；持续失败请联系管理员。
        </p>

        {showDigest && (
          <p className="mt-3 font-mono text-xs text-neutral-400">错误编号：{digest}</p>
        )}

        <div className="mt-5 flex justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-md bg-[#C0322A] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            重试
          </button>
          {layout === "page" && (
            <a
              href="/dashboard"
              className="rounded-md border border-[var(--border)] px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
            >
              返回看板
            </a>
          )}
        </div>
      </section>
    </div>
  )
}
