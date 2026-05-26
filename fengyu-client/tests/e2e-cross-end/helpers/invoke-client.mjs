/**
 * cross-end clientApi invoke wrapper
 *
 * 直接复用 fengyu-client/tests/e2e-cloudfn/helpers/invoke-client.mjs：
 *  - 它链上的 invoke.mjs 安装 wx-server-sdk mock + 懒加载 clientApi/main
 *  - 它的 e2e-cloudfn/setup.mjs 仅注入 env var + 导出常量（不冲突 NS）
 *
 * cross-end 自己的 setup.mjs 必须先 import，PG_CONNECTION_STRING / CLIENT_SECRET 等先生效。
 */
export {
  invokeAs,
  invokePublic,
  invokeClientApiRaw,
  expectError,
  expectSuccess,
} from '../../e2e-cloudfn/helpers/invoke-client.mjs'
