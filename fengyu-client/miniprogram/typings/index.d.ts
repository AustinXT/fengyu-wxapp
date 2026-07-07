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
    logoHeight: number;
    
    continuePayEnabled?: boolean;
    
    pendingInviter?: string;
  };
  initNavBarInfo(): void;
  restoreFromCache(): void;
  syncLoginState(): Promise<void>;
  setMemberFlag(profile: { isMember?: boolean; customerType?: string | null; memberLevel?: string | null }): void;
  clearMemberFlag(): void;
  setUserInfo(info: { userId: string; boundStoreId?: string; boundStoreName?: string }): void;
  setStore(storeId: string, storeName: string, marketName?: string): void;
  capturePendingInviter(options: WechatMiniprogram.App.LaunchShowOption): void;
}
