/**
 * 进销存发布开关。
 *
 * 由环境变量驱动，**默认关闭**（fail-closed）：只有显式设置
 * NEXT_PUBLIC_INVENTORY_LINKAGE_ENABLED=true 才启用。这样 dev 与 prod 共用同一份代码，
 * 分支合并不会把 dev 的启用状态带进 prod。
 *
 * 用 NEXT_PUBLIC_ 前缀是因为 menu.ts 被 sidebar / breadcrumb-nav 两个 'use client' 组件引用，
 * 浏览器端必须读得到。代价是它在 `next build` 时内联，**改值必须重新构建镜像**（同
 * NEXT_PUBLIC_RSA_PUBLIC_KEY 的既有链路：envs/<env>.env → build-manifest.json →
 * docker --build-arg → Dockerfile.admin ARG/ENV）。
 *
 * 开启的前提是目标库已完成 WorkFine 期初库存核验
 * （inventory_cutover_states.workfine_inventory = '已初始化'）。
 *
 * 必须与 clientApi、staffApi、staff 小程序的独立副本保持同步。
 */
const INVENTORY_ENABLED = process.env.NEXT_PUBLIC_INVENTORY_LINKAGE_ENABLED === 'true'

/** 菜单入口显隐（库存管理、提货记录）。 */
export const INVENTORY_ENTRY_ENABLED = INVENTORY_ENABLED

/** 提货等业务是否走库存联动（扣批次、写库存单据）。 */
export const INVENTORY_LINKAGE_ENABLED = INVENTORY_ENABLED
