interface IAppOption {
  globalData: {
    userId: string;
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
  };
  setStaffInfo(info: {
    userId?: string;
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
