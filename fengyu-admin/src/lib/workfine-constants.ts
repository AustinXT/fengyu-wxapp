/**
 * WorkFine 相关纯文案常量。
 *
 * 独立成模块（无 Node-only 依赖）的原因：WorkFine 的运行时逻辑在 ./workfine-mssql，
 * 它 import 了 `mssql`（Node-only）。而 admin 的客户端组件（如 PullWorkfineDialog）
 * 也需要复用「连接 WorkFine 数据库出错」这条兜底文案——若直接 import workfine-mssql，
 * 会把 mssql 拉进浏览器 bundle 导致构建/运行时失败。故把文案抽到此纯文案模块，
 * server（digest）与 client（fallback）共享同一 source，杜绝漂移。
 */

/** WorkFine 连接出错时对用户展示的统一文案（digest 透传与前端兜底共用）。 */
export const WORKFINE_CONNECT_ERROR_MSG =
  '连接 WorkFine 数据库出错，请稍后重试或联系管理员'
