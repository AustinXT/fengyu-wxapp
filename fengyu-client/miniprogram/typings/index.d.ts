interface IAppOption {
  globalData: {
    userInfo: WechatMiniprogram.UserInfo | null;
    userId: string;
    boundStoreName: string;
    boundStoreId: string;
    boundMarketName: string;
    statusBarHeight: number;
    navBarContentHeight: number;
    navBarHeight: number;
  };
  restoreFromCache(): void;
  syncLoginState(): Promise<void>;
  setUserInfo(info: { userId: string; boundStoreId?: string; boundStoreName?: string }): void;
  setStore(storeId: string, storeName: string, marketName?: string): void;
}
