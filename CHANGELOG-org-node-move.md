# 组织架构节点移动功能

## 问题描述
用户反馈："九江易大师中辉店+大润发调整改去九江凤御，无法调整"

系统原有功能只支持创建节点时指定上级，编辑时无法修改归属关系。

## 解决方案

### 前端改进（fengyu-admin）

#### 1. org-page.tsx
- **新增状态**：`parentIdChanged` 追踪上级节点是否变更
- **编辑对话框改造**：
  - 创建模式：上级节点保持只读（原有行为）
  - 编辑模式：上级节点改为可选择的 Select 下拉框

- **智能过滤逻辑**：
  ```typescript
  // 获取所有子孙节点（BFS）
  const getDescendantIds = (nodeId: string): Set<string> => { ... }
  
  // 排除自己和所有子孙节点
  const availableParentNodes = useMemo(() => {
    if (!editingNode) return orgNodes
    const excludeIds = getDescendantIds(editingNode.id)
    return orgNodes.filter((n) => !excludeIds.has(n.id))
  }, [editingNode, orgNodes])
  
  // 根据节点类型过滤合法父节点
  const validParentOptions = useMemo(() => {
    return availableParentNodes.filter((n) => {
      if (formType === "市场") return n.type === "总部"
      if (formType === "门店") return n.type === "市场"
      if (formType === "部门") return n.type !== "部门"
      return true
    })
  }, [availableParentNodes, formType])
  ```

- **提交逻辑**：
  ```typescript
  const updateData: any = {
    name: formName.trim(),
    type: formType,
    sortOrder: formSortOrder,
    isActive: formIsActive,
  }
  // 只有在 parentId 真正改变时才传递
  if (parentIdChanged) {
    updateData.parentId = dialogParentId
  }
  ```

### 后端增强（fengyu-admin/src/actions/org.ts）

#### 1. 新增辅助函数
```typescript
/**
 * 检查 targetId 是否是 nodeId 的子孙节点
 * 使用 BFS 遍历整个子树
 */
async function checkIsDescendant(nodeId: string, targetId: string): Promise<boolean>
```

#### 2. updateOrgNode 增强
```typescript
// 如果修改了 parentId，需要额外校验
if (data.parentId !== undefined && data.parentId !== before?.parentId) {
  // 1. 防止循环引用
  if (data.parentId) {
    const isDescendant = await checkIsDescendant(id, data.parentId)
    if (isDescendant) {
      return { success: false, message: '不能将节点移动到自己的子节点下' }
    }
  }

  // 2. 类型层级约束
  const [newParent] = await db.select(...).from(orgNodes).where(eq(orgNodes.id, data.parentId))
  // - 市场只能在总部下
  // - 门店只能在市场下
  // - 部门不能在部门下
  // - 门店下只能有部门

  // 3. scope 权限验证
  if (!(await isNodeInScope(session, data.parentId))) {
    return { success: false, message: '无权将节点移动到该位置' }
  }
}
```

## 功能特性

### ✅ 核心功能
- 编辑节点时可以修改上级节点
- 下拉框只显示合法的父节点选项
- 创建模式保持原有行为不变

### ✅ 安全防护
1. **防止循环引用**：不能将节点移动到自己或自己的子孙节点下
2. **类型层级约束**：
   - 总部：只能作为根节点
   - 市场：只能在总部下
   - 门店：只能在市场下
   - 部门：不能嵌套
3. **权限控制**：非 admin 只能在自己 scope 内移动节点

### ✅ 用户体验
- 下拉选项根据类型自动过滤，避免无效选择
- 只有真正改变 parentId 才传递给后端，减少不必要的验证
- 乐观锁防止并发修改冲突

## 测试建议

### 手工测试场景

#### 测试 1：正常移动门店
1. 登录管理后台 → 组织架构
2. 选择"九江丽都店"（门店节点）
3. 点击"编辑"
4. 在"上级节点"下拉框选择"九江风尚"（市场节点）
5. 点击"保存"
6. ✅ 验证：左侧树结构更新，门店已移动到新市场下

#### 测试 2：防止循环引用
1. 选择"九江风尚"（市场节点，有多个下级门店）
2. 点击"编辑"
3. ✅ 验证："上级节点"下拉框中不出现：
   - 自己（"九江风尚"）
   - 所有下级门店

#### 测试 3：类型约束
1. 编辑市场节点
2. ✅ 验证：下拉框只显示"总部"
3. 编辑门店节点
4. ✅ 验证：下拉框只显示市场节点
5. 编辑部门节点
6. ✅ 验证：下拉框显示市场和门店，但不显示其他部门

#### 测试 4：创建模式不变
1. 点击"新增子节点"
2. ✅ 验证："上级节点"显示为只读，无法更改

#### 测试 5：错误处理
1. 尝试将节点移动到无权限的 scope
2. ✅ 验证：显示错误提示"无权将节点移动到该位置"

## 部署说明

### 影响范围
- 仅影响 fengyu-admin 管理后台
- 不涉及数据库 schema 变更
- 不影响云函数和小程序端

### 部署步骤
1. 合并代码到 main 分支
2. 部署 fengyu-admin（使用 deploy-admin.sh）
3. 无需数据库迁移

### 回滚方案
如有问题，可以回滚到上一个版本：
- admin 容器回滚：`docker compose down && git checkout <prev-commit> && deploy-admin.sh <env>`

## Git 提交
```
commit 7856fcbd
feat(admin): 组织架构节点支持修改上级节点
```

## 相关文件
- `fengyu-admin/src/app/(main)/org/_components/org-page.tsx` - 前端 UI 和交互逻辑
- `fengyu-admin/src/actions/org.ts` - 后端 action 和校验逻辑
- `fengyu-admin/src/app/(main)/org/_components/__test-manual__.md` - 手工测试清单

## 注意事项
1. 移动节点不会影响该节点下已有的子节点、员工、门店绑定
2. 移动操作会记录到 operation_logs 表（通过 logUpdate）
3. 移动后自动刷新页面以显示最新的组织树结构
