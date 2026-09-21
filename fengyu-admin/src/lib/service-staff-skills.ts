/**
 * 服务指派技能白名单（admin 端单源）。
 *
 * 独立成文件而不是并进 `employee-anchor-market-sql.ts`：后者 import `drizzle-orm`，
 * 而服务单创建页（`"use client"`）也要用白名单派生角色标签，合并会把 drizzle 打进客户端 bundle。
 *
 * ⚠️ 跨端副本（由 fengyu-staff/.../__tests__/routes/anchor-market-sql-snapshot.test.js 守护同序）：
 *   - fengyu-staff/cloudfunctions/staffApi/utils/employee-assignment.js
 *   - fengyu-staff/miniprogram/packageService/service-create/service-create.ts（`SERVICE_ROLES`）
 */

/** 开单等普通指派的服务技能白名单 */
export const DEFAULT_ASSIGNABLE_SKILLS = ['美容师', '养生师']

/**
 * 服务单可指派的技能白名单（issue #210）。
 * ⚠️ 数组顺序即候选列表的角色排序优先级（店经理 → 美容师 → 养生师 → 品项老师），
 *    与 skill_tags.sort_order 当前取值一致。
 */
export const SERVICE_ORDER_ASSIGNABLE_SKILLS = ['店经理', '美容师', '养生师', '品项老师']
