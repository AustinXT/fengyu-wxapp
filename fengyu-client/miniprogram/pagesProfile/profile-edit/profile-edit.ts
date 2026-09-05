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
    isLoggedOut: false,
    isEditing: false,
    editName: '',
    submitting: false,
    restoringLogin: false,
    phoneBinding: false,
  },

  async onRestoreLogin() {
    if (this.data.restoringLogin) return;
    this.setData({ restoringLogin: true });

    const app = getApp<IAppOption>();
    try {
      const status = await app.syncLoginState(true);
      this.refreshData();
      if (status === 'authenticated') {
        Toast.success('登录成功');
      } else if (status === 'phone_required') {
        Toast('请授权手机号完成登录');
      } else {
        Toast.fail('登录失败，请稍后重试');
      }
    } finally {
      this.setData({ restoringLogin: false });
    }
  },

  onLoad() {
    this.refreshData();
  },

  onShow() {
    this.refreshData();
  },

  refreshData() {
    const app = getApp<IAppOption>();
    const isLoggedOut = app.isLoggedOut();
    this.setData({
      userName: isLoggedOut ? '' : (wx.getStorageSync('userName') || ''),
      maskedPhone: isLoggedOut ? '' : maskPhone(wx.getStorageSync('phone') || ''),
      userId: isLoggedOut ? '' : (wx.getStorageSync('userId') || ''),
      boundStoreName: isLoggedOut ? '' : (app.globalData.boundStoreName || ''),
      avatarUrl: isLoggedOut ? '' : (wx.getStorageSync('avatarUrl') || ''),
      isLoggedOut,
      isEditing: isLoggedOut ? false : this.data.isEditing,
    });
  },

  onSwitchStore() {
    if (this.data.isLoggedOut) {
      Toast.fail('请先授权手机号登录');
      return;
    }
    wx.navigateTo({ url: '/pagesStore/store-select/store-select' });
  },

  async onChooseAvatar() {
    if (this.data.isLoggedOut) {
      Toast.fail('请先授权手机号登录');
      return;
    }
    try {
      const res = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed'],
      });
      const chosen = res.tempFiles[0];
      let tempFilePath = chosen.tempFilePath;
      if (!tempFilePath) return;

      wx.showLoading({ title: '上传中...', mask: true });

      // 服务端 img_sec_check 限图片 ≤1MB / 分辨率 ≤750x1334，超限会被 fail-closed 拦截；
      // 大图先压一道（限宽 720 + 质量 80）再上传，避免正常头像被误拦。
      if ((chosen.size || 0) > 1024 * 1024) {
        try {
          const compressed = await wx.compressImage({ src: tempFilePath, quality: 80, compressedWidth: 720 });
          tempFilePath = compressed.tempFilePath;
        } catch (e) {
          // 压缩失败不阻断，继续用原图（若仍超限由服务端拦截）
        }
      }

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
    if (this.data.isLoggedOut) {
      Toast.fail('请先授权手机号登录');
      return;
    }
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
   * 微信手机号授权回调（仅首次绑定或服务端手机号缺失时使用）
   * 已绑定用户的换绑由管理后台操作，前端不再提供入口
   */
  async onGetPhoneNumber(e: WechatMiniprogram.TouchEvent) {
    if (this.data.phoneBinding) return;
    const { cloudID, errMsg } = e.detail;

    if (!cloudID) {
      if (errMsg?.includes('auth deny')) {
        Toast.fail('您拒绝了授权');
      } else if (errMsg) {
        Toast.fail(errMsg);
      }
      return;
    }

    this.setData({ phoneBinding: true });
    const app = getApp<IAppOption>();

    try {
      const { phone } = await bindPhoneWithCloudID(cloudID as string);
      await app.syncLoginState();
      const newMasked = maskPhone(phone);
      wx.setStorageSync('phone', phone);
      if (app.globalData.userInfo) {
        (app.globalData.userInfo as any).phone = phone;
      }
      this.refreshData();
      this.setData({ maskedPhone: newMasked });
      Toast.success('绑定成功');
    } catch (err: any) {
      Toast.fail(err.message || '绑定失败');
    } finally {
      this.setData({ phoneBinding: false });
    }
  },
});
