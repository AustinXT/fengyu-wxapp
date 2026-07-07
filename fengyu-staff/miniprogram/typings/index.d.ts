




type StaffLevel = 'headquarters' | 'market' | 'store_manager' | 'store_staff' | null
type LoginLevel = 'store' | 'management'

interface RoleBinding {
  role: string
  scopeId: string
  scopeType: string 
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
    skills: string[]; 
    
    avatarUrl: string;
    boundStoreName: string;
    boundStoreId: string;
    phone: string;
    
    staffLevel: StaffLevel;
    roleBindings: RoleBinding[];
    availableLoginLevels: LoginLevel[];
    scopedStores: ScopedStore[];
    
    loginLevel: LoginLevel | null;
    currentStoreId: string;
    _serviceCreatePreload?: {
      customer: { id: string; name: string; phone: string; clientUserId?: string };
      items: Array<{
        saleItemId: string; itemName: string; spec: string;
        saleOrderId: string; sessionCount: number; remainingSessions: number;
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
