/**
 * 分页入参安全取值 — staffApi 内部单源（#240）
 *
 * **仅 staffApi 内共用，不跨端**（CLAUDE.md：禁止跨端共享代码目录）。
 * clientApi / payNotify / admin 若有同类需求，各自保留独立副本。
 *
 * 为什么不能只用 `Math.min(max, Math.max(1, Number(x) || d))`：
 *   ① Math.max/min **不取整** —— `pageSize = 2.5` 时 `2.5 > 1` 与 `2.5 < 100` 让两个夹子
 *      双双失效，2.5 原样进 `LIMIT $n`。pg 走扩展协议、参数无类型注解，PG 按 LIMIT 的
 *      上下文推断 `int8` 并对文本 "2.5" 调 `int8in` → 抛
 *      `invalid input syntax for type bigint: "2.5"`（500 级报错，不是优雅降级）。
 *      注意 `0.5` 恰好被 `Math.max(1, …)` 兜住 —— 只有 **2.5 ~ 99.9 区间的小数**会漏出去，
 *      所以不容易被随手测出来。
 *   ② `Math.trunc` 单独也不够 —— `page = 'Infinity'` 经 trunc 仍是 `Infinity`，
 *      `Math.max(1, Infinity)` 还是 `Infinity`，进 OFFSET 一样打到 PG 报错。
 *      故非安全整数（NaN / ±Infinity / 超 2^53 的 1e21）一律回落默认值。
 *
 * 两道防线缺一不可，改这里前先读上面两条。
 */

/**
 * 每页条数默认上限。
 *
 * ⚠️ staffApi 内这个 `100` 原本有 4 处各自 hardcode，本 PR 只收编了 **2 处**
 * （本文件 + `utils/list-filters.js`）。**尚未收编**（follow-up，别以为已经统一）：
 *   - `routes/staff.js:682` `performanceDetail` 的 `toPositiveInt` —— 喂内存 slice 不进 SQL，
 *     且该文件正被 #239 在途修改
 *   - `routes/inventory.js:927/1023/1195` —— 另有 3 份 `parseInt` 归一副本（上限 50/100 混用）
 */
const MAX_PAGE_SIZE = 100

/**
 * 页码上限。不封顶的话 `@returns 三者均为安全整数` 这条契约是假的：
 * `page = Number.MAX_SAFE_INTEGER, pageSize = 100` 时 offset = 900719925474099000，
 * `Number.isSafeInteger(offset)` 为 false；maxPageSize 被调高时 offset 还会越过 1e21，
 * 此时 `String(offset)` 输出指数记法 `"2e+21"`，pg 按文本传参直接让 PG `int8in` 报错
 * —— 正是本 issue 要修的那个 500。
 * 封顶后 offset ≤ (1e6-1) × MAX_PAGE_SIZE_CEILING ≈ 1e9，恒为安全整数。
 * 口径与 admin `src/lib/inventory/engine.ts` 的 `normalizePage`（MAX_PAGE = 1_000_000）对齐。
 */
const MAX_PAGE = 1_000_000

/**
 * `maxPageSize` 这个**参数本身**的硬上限。
 *
 * 双谱系评审同时指出：不校验第 4 参，`Math.min(cap, n)` 就能把非法值直接吐出出口 ——
 * `safePaging(1, 1, 1, 0.5)` → `safePageSize = 0.5`；`(…, NaN)` → `NaN`；`(…, -10)` → `-10`
 * （`-10` 还恰好满足 `isSafeInteger`，说明光靠「是安全整数」这条判据不够）。
 *
 * 另一条：**安全整数对乘法不封闭** —— 即使 page 与 pageSize 各自都是安全整数，
 * `offset = (page-1) × pageSize` 仍可越过 2^53。契约成立的隐藏前提是
 * `(MAX_PAGE - 1) × maxPageSize ≤ 2^53 - 1`，即 `maxPageSize ≤ ~9.0e9`。
 *
 * 取 1000（业务上任何列表都不会一页过千）后 offset ≤ 1e9，两条一起关死，
 * 「三个出口均为安全整数」才是**无条件**成立的。
 */
const MAX_PAGE_SIZE_CEILING = 1000

/**
 * @param {*} page        页码入参（任意类型，非法值回落 1；超过 MAX_PAGE 被夹到 MAX_PAGE）
 * @param {*} pageSize    每页条数入参（任意类型，非法值回落 defaultPageSize）
 * @param {number} defaultPageSize 该调用点的默认每页条数（如顾客档案 20、管理层列表 50）
 * @param {number} [maxPageSize=MAX_PAGE_SIZE] 每页条数上限（默认 100），超出被夹到该值
 * @returns {{ safePage: number, safePageSize: number, offset: number }}
 *          三者**均为安全整数**（`Number.isSafeInteger` 为真）且 ≥ 1（offset ≥ 0）。
 *          这条契约是**无条件**的——四个入参全部过归一，见 MAX_PAGE / MAX_PAGE_SIZE_CEILING 注释
 */
function safePaging(page, pageSize, defaultPageSize, maxPageSize = MAX_PAGE_SIZE) {
  // 三个出口走同一条归一：取整 → 安全整数且 ≥1 → 夹到上限，否则回落。
  const clampInt = (raw, cap, fallback) => {
    const n = Math.trunc(Number(raw))
    return Number.isSafeInteger(n) && n >= 1 ? Math.min(cap, n) : fallback
  }

  // ⚠️ 上限参数本身也必须先归一，否则它就是契约的破口：
  // `Math.min(cap, n)` 会把 cap 的小数 / 负数 / NaN 原样带到出口（见 MAX_PAGE_SIZE_CEILING 注释）。
  const cap = clampInt(maxPageSize, MAX_PAGE_SIZE_CEILING, MAX_PAGE_SIZE)

  const safePage = clampInt(page, MAX_PAGE, 1)
  // 回落值本身也要过一遍归一：调用方传的 defaultPageSize 是常量，非法即编程错误，
  // 但本 helper 是 invariant D-search-pagination 的抄写模板，不能留一条
  // 「回落分支能吐出 > maxPageSize 或非整数」的路径（否则坑会跟着模板扩散）。
  // 非法时兜到 1：宁可一页少返回，也不放任失控值进 LIMIT
  // —— 尤其 `undefined` 会被 pg 序列化成 `null`，而 `LIMIT NULL` 在 PG 等于**不限行数**。
  const fallbackPageSize = clampInt(defaultPageSize, cap, 1)
  // 非法值（0 / 负数 / NaN / Infinity / 超安全整数）一律回落调用点默认值，
  // 语义与改造前的 `Number(pageSize) || <默认>` 一致。
  const safePageSize = clampInt(pageSize, cap, fallbackPageSize)

  return { safePage, safePageSize, offset: (safePage - 1) * safePageSize }
}

module.exports = {
  safePaging,
  MAX_PAGE,
  MAX_PAGE_SIZE,
  MAX_PAGE_SIZE_CEILING,
}
