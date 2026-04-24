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
    /** Ticket 2026-04-24 PR-C：多次回款"继续支付"灰度开关 */
    continuePayEnabled?: boolean;
  };
  initNavBarInfo(): void;
  restoreFromCache(): void;
  syncLoginState(): Promise<void>;
  setUserInfo(info: { userId: string; boundStoreId?: string; boundStoreName?: string }): void;
  setStore(storeId: string, storeName: string, marketName?: string): void;
}
