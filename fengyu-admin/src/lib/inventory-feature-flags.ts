/**
 * 提货登记入口与进销存联动独立控制，缺失配置时关闭。
 * NEXT_PUBLIC_ 在 next build 时内联，改值须重新构建 admin 镜像。
 * envs/<env>.env → build-manifest.json → build-arg → Dockerfile ARG/ENV。
 * ENTRY 只控制提货记录；库存入口与扣批次/生成 GCK 仍由 LINKAGE 控制，
 * 联动开启前必须完成 WorkFine 期初库存核验。
 */
export const INVENTORY_ENTRY_ENABLED = process.env.NEXT_PUBLIC_INVENTORY_ENTRY_ENABLED === 'true'
export const INVENTORY_LINKAGE_ENABLED = process.env.NEXT_PUBLIC_INVENTORY_LINKAGE_ENABLED === 'true'
