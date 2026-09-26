/**
 * 员工维度数值口径说明（#299）：scope 只决定哪些员工上榜，金额类 CTE 不按 scope 过滤，
 * 数值是员工在所有门店（含跨店、停用门店）的产出。
 *
 * 用在 admin 人效板「员工排名榜」「按技师人效」，与 staff 管理端 `mgmt-dashboard.wxml`
 * 员工排行榜逐字一致，由 staffApi `cross-end-staff-output-note.test.js` 钉住；
 * 导出件「导出说明」sheet 随 #296 复用本常量。
 */
export const STAFF_OUTPUT_SCOPE_NOTE = "数值为员工个人全域产出"
