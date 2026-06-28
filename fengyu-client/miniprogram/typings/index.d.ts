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
    /** Ticket 2026-04-24 PR-C：多次回款"继续支付"灰度开关 */
    continuePayEnabled?: boolean;
    /** Ticket 2026-04-24 分享礼：从分享链接 query 捕获的邀请人 userId；绑定门店时一次性写入并清空 */
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
