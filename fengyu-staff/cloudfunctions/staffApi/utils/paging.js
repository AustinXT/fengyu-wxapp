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
 *
 * @param {*} page        页码入参（任意类型，非法值回落 1）
 * @param {*} pageSize    每页条数入参（任意类型，非法值回落 defaultPageSize）
 * @param {number} defaultPageSize 该调用点的默认每页条数（如顾客档案 20、管理层列表 50）
 * @param {number} [maxPageSize=100] 每页条数上限，超出被夹到该值
 * @returns {{ safePage: number, safePageSize: number, offset: number }} 三者均为安全整数
 */
function safePaging(page, pageSize, defaultPageSize, maxPageSize = 100) {
  const pageNum = Math.trunc(Number(page))
  const safePage = Number.isSafeInteger(pageNum) && pageNum >= 1 ? pageNum : 1
  const pageSizeNum = Math.trunc(Number(pageSize))
  // 非法值（0 / 负数 / NaN / Infinity / 超安全整数）一律回落调用点默认值，
  // 语义与改造前的 `Number(pageSize) || <默认>` 一致。
  const safePageSize = Number.isSafeInteger(pageSizeNum) && pageSizeNum >= 1
    ? Math.min(maxPageSize, pageSizeNum)
    : defaultPageSize
  return { safePage, safePageSize, offset: (safePage - 1) * safePageSize }
}

module.exports = {
  safePaging,
}
