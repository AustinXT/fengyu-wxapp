interface IAppOption {
  globalData: {
    staffWfId: string;
    staffName: string;
    position: string;
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
      workfineItemId: string;
      directCheckout?: boolean;
    } | null;
    _serviceCreatePreload?: {
      customer: { id: string; name: string; phone: string; clientUserId?: string };
      items: Array<{
        itemFlowNo: string; itemName: string; spec: string;
        orderNo: string; sessionCount: number; remainingSessions: number;
      }>;
    } | null;
  };
  setStaffInfo(info: {
    staffWfId?: string;
    staffName?: string;
    position?: string;
    phone?: string;
    boundStoreName?: string;
    boundStoreId?: string;
  }): void;
  resetStaffInfo(): void;
  syncLoginState(): Promise<void>;
  _loginReady: Promise<void>;
}
