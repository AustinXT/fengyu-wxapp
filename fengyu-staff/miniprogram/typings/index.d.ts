// 员工层级归并结果（前端派生），取值参考云函数 utils/scope.js
// headquarters  — 总部
// market        — 市场
// store_manager — 门店店长
// store_staff   — 门店其他角色（美容师 / 咨询 / 财务门店等）
type StaffLevel = 'headquarters' | 'market' | 'store_manager' | 'store_staff' | null
type LoginLevel = 'store' | 'management'

interface RoleBinding {
  role: string
  roleName?: string
  isStoreManager?: boolean
  scopeId: string
  scopeType: string // 总部 / 市场 / 门店 / 部门
  scopeName: string
}

interface ScopedStore {
  storeId: string
  storeName: string
}

interface IAppOption {
  globalData: {
    staffWfId: string;
    staffName: string;
    position: string;
    roles: string[];
    skills: string[]; // P2-14：技能标签（用于业绩分配角色推断）
    /** 头像 URL（cloud:// fileID；员工端渲染前需通过 toHttpUrl 转 HTTPS） */
    avatarUrl: string;
    boundStoreName: string;
    boundStoreId: string;
    phone: string;
    // 权限层级（由云函数 auth.login/bindPhone 返回）
    staffLevel: StaffLevel;
    roleBindings: RoleBinding[];
    availableLoginLevels: LoginLevel[];
    scopedStores: ScopedStore[];
    managerStores: ScopedStore[];
    /** manager 角色管辖门店的 id 列表；兼容部分 auth 缓存/响应。 */
    managerStoreIds: string[];
    // 运行时
    loginLevel: LoginLevel | null;
    currentStoreId: string;
    _serviceCreatePreload?: {
      customer: { id: string; name: string; phone: string; clientUserId?: string };
      items: Array<{
        saleItemId: string; itemName: string; spec: string;
        saleOrderId: string; sessionCount: number; remainingSessions: number; unit?: string;
      }>;
    } | null;
  };
  setStaffInfo(info: {
    staffWfId?: string;
    staffName?: string;
    position?: string;
    roles?: string[];
    skills?: string[];
    avatarUrl?: string | null;
    phone?: string;
    boundStoreName?: string;
    boundStoreId?: string;
    staffLevel?: StaffLevel;
    roleBindings?: RoleBinding[];
    availableLoginLevels?: LoginLevel[];
    scopedStores?: ScopedStore[];
    managerStores?: ScopedStore[];
    managerStoreIds?: string[];
  }): void;
  setLoginLevel(level: LoginLevel): void;
  setCurrentStoreId(storeId: string): void;
  resetStaffInfo(): void;
  switchLoginLevel(target: LoginLevel): void;
  restoreFromCache(): void;
  syncLoginState(): Promise<void>;
  switchTestUser(phone: string | null): Promise<void>;
  _loginReady: Promise<void>;
}
