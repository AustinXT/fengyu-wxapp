// pagesProfile/profile-edit/profile-edit.ts
import Toast from '@vant/weapp/toast/toast';
import { maskPhone } from '../../utils/format';
import { callClientApi, bindPhoneWithCloudID } from '../../utils/cloud';

Page({
  data: {
    userName: '',
    maskedPhone: '',
    userId: '',
    boundStoreName: '',
    avatarUrl: '',
    isEditing: false,
    editName: '',
    submitting: false,
  },

  onLoad() {
    const app = getApp<IAppOption>();
    this.setData({
      userName: wx.getStorageSync('userName') || '',
      maskedPhone: maskPhone(wx.getStorageSync('phone') || ''),
      userId: wx.getStorageSync('userId') || '',
      boundStoreName: app.globalData.boundStoreName || '',
      avatarUrl: wx.getStorageSync('avatarUrl') || '',
    });
  },

  onShow() {
    const app = getApp<IAppOption>();
    this.setData({ boundStoreName: app.globalData.boundStoreName || '' });
  },

  onSwitchStore() {
    wx.navigateTo({ url: '/pagesStore/store-select/store-select' });
  },

  async onChooseAvatar() {
    try {
      const res = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed'],
      });
      const tempFilePath = res.tempFiles[0].tempFilePath;
      if (!tempFilePath) return;

      wx.showLoading({ title: '上传中...', mask: true });
      const ext = (tempFilePath.split('.').pop() || 'jpg').toLowerCase();

      // 读取临时文件为 base64（小程序端直传 COS 被存储安全规则拦截，改走云函数代理）
      const base64 = await new Promise<string>((resolve, reject) => {
        wx.getFileSystemManager().readFile({
          filePath: tempFilePath,
          encoding: 'base64',
          success: (r) => resolve(r.data as string),
          fail: reject,
        });
      });

      const { fileID } = await callClientApi<{ fileID: string }>('auth.uploadAvatar', { base64, ext });
      wx.setStorageSync('avatarUrl', fileID);
      this.setData({ avatarUrl: fileID });
      wx.hideLoading();
      Toast.success('头像已更新');
    } catch (err: any) {
      wx.hideLoading();
      if (err.errMsg?.includes('chooseMedia:fail cancel')) return;
      Toast.fail(err.message || '上传失败');
    }
  },

  onEditName() {
    this.setData({
      isEditing: true,
      editName: this.data.userName,
    });
  },

  onNameInput(e: WechatMiniprogram.Input) {
    this.setData({ editName: e.detail.value });
  },

  onCancelEdit() {
    this.setData({ isEditing: false, editName: '' });
  },

  async onSaveName() {
    const name = this.data.editName.trim();
    if (!name) {
      Toast.fail('昵称不能为空');
      return;
    }
    if (this.data.submitting) return;
    this.setData({ submitting: true });

    try {
      await callClientApi('auth.updateProfile', { name });
      wx.setStorageSync('userName', name);
      this.setData({
        userName: name,
        isEditing: false,
        editName: '',
      });
      Toast.success('修改成功');
    } catch (err: any) {
      Toast.fail(err.message || '修改失败');
    } finally {
      this.setData({ submitting: false });
    }
  },

  /**
   * 微信手机号授权回调（仅用于首绑场景）
   * 已绑定用户的换绑由管理后台操作，前端不再提供入口
   */
  async onGetPhoneNumber(e: WechatMiniprogram.TouchEvent) {
    const { cloudID, errMsg } = e.detail;

    if (!cloudID) {
      if (errMsg?.includes('auth deny')) {
        Toast.fail('您拒绝了授权');
      } else if (errMsg) {
        Toast.fail(errMsg);
      }
      return;
    }

    const app = getApp<IAppOption>();

    try {
      const { phone } = await bindPhoneWithCloudID(cloudID as string);
      const newMasked = maskPhone(phone);
      wx.setStorageSync('phone', phone);
      if (app.globalData.userInfo) {
        (app.globalData.userInfo as any).phone = phone;
      }
      this.setData({ maskedPhone: newMasked });
      Toast.success('绑定成功');
    } catch (err: any) {
      Toast.fail(err.message || '绑定失败');
    }
  },
});
