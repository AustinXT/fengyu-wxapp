import type { AuthSession } from './types'
import { isAdminScope } from './session-role-guards'
import { scopeSessionToActions } from './action-scope'

/**
 * 技能标签三个写操作（create / update / delete）外层 `withPermission` 用的权限点。
 *
 * UI 显隐与 Server Action 必须用同一个值，否则两端会对"谁能进这道门"产生分歧。
 */
export const SKILL_TAG_WRITE_ACTION = 'employee:update'

/**
 * 能否管理技能标签字典（新增 / 重命名 / 删除）—— **仅系统管理员**（#211）。
 *
 * 技能标签是服务提成矩阵「市场 × 技能标签」的维度，非管理员随意增改会造成矩阵错配、
 * 提成静默分配不到人，故收紧到角色级硬闸，不做成可单独授予的权限点。
 *
 * 本函数是 UI 侧判定，与服务端 `withPermission(SKILL_TAG_WRITE_ACTION, …)`
 * + 函数体首行 `requireAdmin(session)` 的**组合效果**逐位同构。两项各对应一道闸门：
 *
 * 1. `actions.includes(...)` 对应外层 `requirePermission`：运营若在权限矩阵 UI 摘掉 admin
 *    的该权限，服务端会先拒，UI 就不该显示一个点了必报错的按钮。
 *    ⚠️ 这里刻意**不用** `hasUiCapability` —— 它除动作本身外还要求 UI 依赖项闭包
 *    （`employee:update` 的依赖是 `employee:list`/`org:list`/`store:list`，那是**员工表单页**
 *    的硬依赖，与只列技能标签的管理弹窗无关）。混进来会让 UI 比服务端更严，出现
 *    「API 调得通却看不到入口」的有向偏差，也让本函数名不副实。页面本身能不能进，
 *    由 `requireUiPageCapability` 单独把关，是另一个关注点。
 * 2. `scopeSessionToActions` 不可省：`withPermission` 交给 `requireAdmin` 的不是原始
 *    session，而是按该 action 收紧后的（只保留自身 actions 含该动作的角色行）。若这里
 *    图省事用原始 session，`admin + hr` 双角色会话在 admin 被摘掉该权限时会算出 true
 *    （hr 补上了 union），而服务端收紧后只剩 hr → 按钮可见却必然被拒。
 *
 * 判定口径集中在此处，是为了让上述复刻只存在一份 —— 服务端管线若变（换 action、
 * 改 scope 规则），改这里一处即可，不必在页面里逐个追。对应单测见 `skill-tag-access.test.ts`。
 */
export function canManageSkillTags(session: AuthSession | null): boolean {
  if (!session) return false
  return (
    session.permissions.actions.includes(SKILL_TAG_WRITE_ACTION)
    && isAdminScope(scopeSessionToActions(session, [SKILL_TAG_WRITE_ACTION]))
  )
}
