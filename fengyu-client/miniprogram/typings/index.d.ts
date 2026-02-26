interface IAppOption {
  globalData: {
    userInfo: WechatMiniprogram.UserInfo | null;
    userId: string;
    boundStoreName: string;
    boundStoreId: string;
    boundMarketName: string;
  };
  restoreFromCache(): void;
  syncLoginState(): Promise<void>;
  setUserInfo(info: { userId: string; boundStoreName?: string }): void;
  setStore(storeName: string, marketName?: string): void;
}
