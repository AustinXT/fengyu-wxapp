/**
 * 分页入参归一 — fengyu-admin 内部单源（#281）
 *
 * **仅 admin 内共用，不跨端**（CLAUDE.md：禁止跨端共享代码目录）。
 * 同缺陷类的其余副本各自独立、不得 import：
 *   - staffApi：`fengyu-staff/cloudfunctions/staffApi/utils/paging.js` 的 `safePaging`（#240 已修）
 *   - clientApi：见 #272（未修）
 * 改这里时顺手看一眼那两处是否同型漂移。
 *
 * ## 为什么 `Math.min(max, Math.max(1, Number(x) || d))` 不够
 *
 * ① **`Math.max` / `Math.min` 不取整** —— `page = 2.5` 时 `2.5 > 1` 让夹子失效，
 *    `2.5` 原样进 `offset = (2.5 - 1) * 10 = 15`；`pageSize = 2.5` 时 `2.5 > 1` 且
 *    `2.5 < 100`，两个夹子双双失效直接进 `.limit()`。Drizzle 走 pg 扩展协议、参数无类型
 *    注解，PG 按 `LIMIT`/`OFFSET` 的上下文推断 `int8` 并对文本 `"2.5"` 调 `int8in`
 *    → 抛 `invalid input syntax for type bigint: "2.5"`。该串没有 9 项错误前缀，
 *    被全局 catch 降级成 500 而不是 -400。
 *    注意 `0.5` 恰好被 `Math.max(1, …)` 兜住 —— 只有 **2.5 ~ 99.9 区间的小数**会漏出去，
 *    所以不容易被随手测出来。
 *
 * ② **`Math.trunc` 单独也不够** —— `page = Infinity` 经 trunc 仍是 `Infinity`；
 *    `page = 1e21` 是有限值，`Number.isFinite` 放行，但 `offset = 1e21 * 20 = 2e22`
 *    经 `String()` 输出**指数记法** `"2e+22"`，PG `int8in` 同样报错。
 *    故判据必须是 `Number.isSafeInteger` 而非 `Number.isFinite`。
 *
 * 两道防线缺一不可，改这里前先读上面两条。
 */

/**
 * 页码上限。不封顶的话「三个出口均为安全整数」这条契约是假的：
 * **安全整数对乘法不封闭** —— `page = Number.MAX_SAFE_INTEGER, pageSize = 100` 时
 * `offset = 900719925474099000`，`Number.isSafeInteger(offset)` 已为 false。
 * 封顶后 `offset ≤ (1e6 - 1) × MAX_PAGE_SIZE_CEILING ≈ 1e9`，恒为安全整数。
 *
 * 100 万页 × 100 条/页 = 1 亿行，远超任何业务规模，夹到这里不会误伤真实翻页。
 * 口径与 staffApi `utils/paging.js` 的 `MAX_PAGE` 对齐。
 */
export const MAX_PAGE = 1_000_000

/** 每页条数默认上限。白名单型调用点用不到它（白名单本身更严），clamp 型（allocations）才走。 */
export const MAX_PAGE_SIZE = 100

/**
 * `maxPageSize` 这个**参数本身**的硬上限。
 *
 * 不校验第 4 参，`Math.min(cap, n)` 就能把非法值直接吐出出口：
 * `maxPageSize = 0.5` → 出口 `0.5`；`NaN` → `NaN`；`-10` → `-10`
 * （`-10` 还恰好满足 `isSafeInteger`，说明光靠「是安全整数」这条判据不够，还得 ≥ 1）。
 *
 * 取 1000 后 `(MAX_PAGE - 1) × 1000 ≈ 1e9 < 2^53`，乘法不封闭那条也一起关死，
 * 「三个出口均为安全整数」才是**无条件**成立的。
 */
export const MAX_PAGE_SIZE_CEILING = 1000

/**
 * 归一成 `[1, cap]` 区间内的安全整数，非法值回落 `fallback`。
 *
 * ⚠️ `Number(raw)` 会抛，触发形状**可以来自普通 JSON**：
 * `JSON.parse('{"toString": null}')` 是个普通对象，ToPrimitive 先试
 * `Object.prototype.valueOf`（返回对象本身，非原始值）再试 `toString`（被遮蔽成 null，
 * 不可调用）→ `TypeError: Cannot convert object to primitive value`。
 * admin 的列表入参目前都来自 URL query（都是 string），这条**当前不可达**，
 * 但本文件是该缺陷类的抄写模板，留破口会跟着扩散，故照样兜住。
 */
function clampInt(raw: unknown, cap: number, fallback: number): number {
  let n: number
  try {
    n = Math.trunc(Number(raw))
  } catch {
    return fallback
  }
  return Number.isSafeInteger(n) && n >= 1 ? Math.min(cap, n) : fallback
}

/**
 * 页码归一。非法值（小数 / 0 / 负数 / NaN / ±Infinity / 超安全整数）一律回落 1，
 * 超过 {@link MAX_PAGE} 夹到 MAX_PAGE。
 *
 * @returns 恒为 `[1, MAX_PAGE]` 区间内的安全整数
 */
export function normalizePage(value: unknown): number {
  return clampInt(value, MAX_PAGE, 1)
}

export interface ResolvePagingInput {
  /** 页码入参，任意类型 */
  page: unknown
  /** 每页条数入参，任意类型 */
  pageSize: unknown
  /** 该调用点的默认每页条数 */
  defaultPageSize: number
  /**
   * 给了就走**白名单严格匹配**（不在白名单一律回落 `defaultPageSize`），
   * 不给则走 clamp 到 `maxPageSize`。
   *
   * 白名单口径必须与该列表 UI 的 `PAGE_SIZE_OPTIONS` 一致 —— 两侧不同源时，
   * `?size=7` 会让服务端每页 7 条而 UI 按 20 条算页数，尾部数据翻到哪一页都够不到，
   * 且不会有任何报错。
   */
  allowedPageSizes?: readonly number[]
  /** clamp 模式下的每页条数上限，默认 {@link MAX_PAGE_SIZE} */
  maxPageSize?: number
}

/**
 * 分页三元组归一。**这是 admin 唯一允许算 `offset` 的地方** —— 在调用点自己乘，
 * 契约就退化成「靠调用点两个入参都恰好正确」。
 *
 * @returns `page` / `pageSize` / `offset` 三者**均为安全整数**
 *          （`Number.isSafeInteger` 为真），`page`、`pageSize` ≥ 1，`offset` ≥ 0。
 *          这条契约是**无条件**的：四个入参全部过归一，见 MAX_PAGE / MAX_PAGE_SIZE_CEILING 注释
 */
export function resolvePaging(input: ResolvePagingInput): {
  page: number
  pageSize: number
  offset: number
} {
  const { page, pageSize, defaultPageSize, allowedPageSizes, maxPageSize = MAX_PAGE_SIZE } = input

  // ⚠️ 上限参数本身也必须先归一，否则它就是契约的破口（见 MAX_PAGE_SIZE_CEILING 注释）。
  // 外层再夹一次 ceiling 是**结构性双保险**：`clampInt` 的 fallback 参数不经过 cap，
  // 若将来有人把 MAX_PAGE_SIZE 调到 > CEILING，非法 maxPageSize 会从 fallback 旁路溜过 ceiling。
  const cap = Math.min(
    MAX_PAGE_SIZE_CEILING,
    clampInt(maxPageSize, MAX_PAGE_SIZE_CEILING, MAX_PAGE_SIZE),
  )

  // 回落值本身也要过一遍归一：调用方传的 defaultPageSize 是常量，非法即编程错误，
  // 但兜到 1 而不是放行 —— 尤其 `undefined` 会被 pg 序列化成 `null`，
  // 而 `LIMIT NULL` 在 PG 等于**不限行数**（静默全表返回）。
  const fallbackPageSize = clampInt(defaultPageSize, cap, 1)

  const safePage = normalizePage(page)
  const safePageSize = allowedPageSizes
    // 白名单模式：严格相等匹配。`2.5` / `'20'` / `Infinity` 都不在白名单 → 回落。
    // ⚠️ 命中后仍要走 `clampInt` 而不是 `Math.min(cap, …)`：白名单是**代码常量**，
    // 但若哪天有人把它写成 `[10, 20.5]`，`Math.min` 会把 20.5 原样吐到 `.limit()`，
    // 「出口恒为安全整数」这条契约就从白名单这一侧破了。
    ? (allowedPageSizes.includes(pageSize as number)
        ? clampInt(pageSize, cap, fallbackPageSize)
        : fallbackPageSize)
    // clamp 模式：非法值回落调用点默认值，语义与改造前的 `Number(pageSize) || <默认>` 一致。
    : clampInt(pageSize, cap, fallbackPageSize)

  return { page: safePage, pageSize: safePageSize, offset: (safePage - 1) * safePageSize }
}
