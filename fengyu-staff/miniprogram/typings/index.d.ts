interface IAppOption {
  globalData: {
    userId: string;
    staffWfId: string;
    staffName: string;
    role: 'manager' | 'beautician' | '';
    boundStoreName: string;
    boundStoreId: string;
    phone: string;
  };
  setStaffInfo(info: {
    userId?: string;
    staffWfId?: string;
    staffName?: string;
    role?: 'manager' | 'beautician' | '';
    phone?: string;
    boundStoreName?: string;
    boundStoreId?: string;
  }): void;
}
