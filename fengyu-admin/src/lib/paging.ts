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
 * ① **`Math.max` / `Math.min` 不取整** —— `Math.max(1, x)` 只把 `x ≤ 1` 的值抬到 1，
 *    **任何 > 1 的小数原样透传，没有上界**（`1.1` / `150.5` / `1e7 + 0.5` 全漏）。
 *    只有 `0 < x ≤ 1` 的小数（如 `0.5`）恰好被兜住。
 *    pageSize 侧多一道 `Math.min(100, …)`，所以那条路径漏的是开区间 `(1, 100)` 的小数。
 *
 *    漏出去之后分两种后果，**别把它们混成一种**：
 *    - **乘积恰好是整数 → 不报错，静默返回错误的行区间**。`?page=2.5&size=10` 的
 *      `offset = (2.5 - 1) * 10 = 15`，`String(15)` 就是 `"15"`，PG 照单全收，
 *      用户拿到第 16~35 条而 UI 高亮第 2 页 —— 翻页时必然重复/跳过行，且零报错。
 *    - **乘积带浮点尾巴 → 500**。`?page=1.3&size=10` 的 `offset` 是
 *      `3.0000000000000004`；`pageSize = 2.5` 直接进 `.limit()`。Drizzle 走 pg 扩展协议、
 *      参数无类型注解，PG 按 `LIMIT`/`OFFSET` 的上下文推断 `int8` 并对文本调 `int8in`
 *      → 抛 `invalid input syntax for type bigint`。该串没有 9 项错误前缀，
 *      被全局 catch 降级成 500 而不是 -400。
 *
 *    后一种响，前一种不响却更危险 —— 这是这条缺陷难被随手测出来的真正原因。
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
 * 不可调用）→ `TypeError: Cannot convert object to primitive value`。`Symbol()` 同样抛。
 *
 * 可达性：**URL 路径不可达**（query 过来的都是 string），但 **Server Action 直调路径可达**
 * —— action 可被客户端任意构造调用，`{toString: null}` 是普通对象、能过 RSC 序列化边界。
 * 抛出去会被全局 catch 降级成 500，正是本 issue 要消灭的那类非优雅降级。
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
 * 页码归一。**小数按 `Math.trunc` 截断**（`2.5` → `2`、`1.3` → `1`），
 * 不是回落 1 —— 截断后若仍 ≥ 1 就用截断值，这与客户端 `pagination.tsx` 的
 * `Math.floor` 同向（页码恒为正，两者等价）。
 * 真正**回落 1** 的是：`0` / 负数 / `NaN` / `±Infinity` / 超安全整数（如 `1e21`）/ 非数值。
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

  const safePage = normalizePage(page)

  // ⚠️ 判 `Array.isArray` 而不是判真值，也不是只判 `?.length`：
  // - `allowedPageSizes: []` 是 **truthy**，判真值会让空白名单永远 miss、
  //   pageSize 入参被静默忽略
  // - `{ length: 2 }` 能过 `?.length` 却没有 `.includes`，会抛
  //   `TypeError: allowedPageSizes.includes is not a function` → 全局 catch → 500，
  //   正是本 issue 要消灭的降级类。TS 类型挡得住编译期，挡不住 action 直调
  const safePageSize = Array.isArray(allowedPageSizes) && allowedPageSizes.length > 0
    ? pickFromWhitelist(allowedPageSizes, pageSize, defaultPageSize)
    // clamp 模式：非法值回落调用点默认值。
    // ⚠️ 与改造前 `Math.min(100, Math.max(1, Number(x) || 20))` **不是逐值等价**，
    // 有两处刻意的 delta（都是「非法值更早地回落到默认页长」，方向无风险）：
    //   `?pageSize=0.5` 旧得 1（被 Math.max 抬上来）、新回落 20
    //   `?pageSize=-5`  旧得 1（同上）、新回落 20
    //
    // 回落值自己也过一遍归一，兜底到 1 而不是放行 —— 失控的 pageSize 进 `.limit()`
    // 的后果比「一页只返回 1 条」严重得多：
    // 这里常被写成「`undefined` 会变成 `LIMIT NULL`，而 `LIMIT NULL` 等于不限行数」——
    // 结论对，机制不对（drizzle 0.45 实测）：`pg-core/dialect.cjs:288` 的守卫是
    // `typeof limit === 'object' || (typeof limit === 'number' && limit >= 0)`，
    // 所以 `undefined` / `NaN` / 负数是**整条 limit 子句根本不发出**（比 LIMIT NULL 更隐蔽，
    // EXPLAIN 里连 Limit 节点都没有）；只有字面 `null`（`typeof null === 'object'`）
    // 才真走 `LIMIT $1` = NULL。两条路径后果相同：**静默全表返回**。
    : clampInt(pageSize, cap, clampInt(defaultPageSize, cap, 1))

  return { page: safePage, pageSize: safePageSize, offset: (safePage - 1) * safePageSize }
}

/**
 * 白名单模式下挑一个合法页长。**出口一定落在白名单里**（白名单整个不可用时才兜 1）。
 *
 * 这里刻意**完全不碰 `maxPageSize`/`cap`**：白名单的语义就是「只允许这几个值」，
 * cap 在这个模式下无话语权。夹一下 cap 会让出口落在白名单之外 ——
 * `{allowedPageSizes:[10,20,50], maxPageSize:30}` 时 `pageSize=50` 会被压成 30、
 * `pageSize=7` 会经 fallback 被压成 30，而 30 不是任何一个 UI 选项：
 * 服务端每页 30 条、UI 按 50 算页数 → 尾部数据翻到哪一页都够不到，且零报错。
 *
 * 命中值仍要逐项校验 —— 白名单是代码常量，但若哪天被写成 `[10, 20.5]`，
 * 20.5 原样吐到 `.limit()` 就从这一侧破掉了「出口恒为安全整数」；
 * `≤ CEILING` 那道也不能省（`[10, 1e15]` 命中后 offset 越过 2^53，
 * 「乘法不封闭」对白名单这一侧同样成立）。
 */
function pickFromWhitelist(
  allowed: readonly number[],
  pageSize: unknown,
  defaultPageSize: unknown,
): number {
  const legal = (v: unknown): v is number =>
    Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= MAX_PAGE_SIZE_CEILING
  const pick = (v: unknown): number | null =>
    allowed.includes(v as number) && legal(v) ? (v as number) : null

  return pick(pageSize)
    // 调用点的 defaultPageSize 必须自己也在白名单里，否则它就是个「白名单外的出口」
    ?? pick(defaultPageSize)
    // defaultPageSize 也不在白名单（调用点写错了）→ 退而取白名单里第一个合法值，
    // 至少保证出口是 UI 认得的选项之一
    ?? allowed.find(legal)
    // 整个白名单都不合法 → 宁可一页只返回 1 条，也不放任失控值进 LIMIT
    ?? 1
}
