interface IAppOption {
  globalData: {
    staffWfId: string;
    staffName: string;
    position: string;
    roles: string[];
    skills: string[]; // P2-14：技能标签（用于业绩分配角色推断）
    boundStoreName: string;
    boundStoreId: string;
    phone: string;
    pendingCartItem?: {
      spuId: string;
      skuId: string;
      spuName: string;
      specName: string;
      price: number;
      quantity: number;
      sessionCount: number;
      productType: string;
      workfineItemId?: string;
      directCheckout?: boolean;
    } | null;
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
    phone?: string;
    boundStoreName?: string;
    boundStoreId?: string;
  }): void;
  resetStaffInfo(): void;
  restoreFromCache(): void;
  syncLoginState(): Promise<void>;
  _loginReady: Promise<void>;
}
