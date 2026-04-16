// pagesProfile/profile-edit/profile-edit.ts
import Toast from '@vant/weapp/toast/toast';
import Dialog from '@vant/weapp/dialog/dialog';
import { maskPhone } from '../../utils/format';
import { callClientApi, bindPhoneWithCloudID, rebindPhoneWithCloudID } from '../../utils/cloud';

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
    /** 换绑二次确认后才渲染真正的授权按钮 */
    showRebindAuth: false,
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
   * 换绑：点击"更换手机号"按钮先弹 dialog 二次确认
   * 确认后切换 showRebindAuth=true，wxml 渲染出 open-type=getPhoneNumber 按钮，
   * 用户再点一次真正触发微信授权（微信限制：必须由 button 的 tap 事件直接触发）
   */
  async onRequestRebind() {
    try {
      await Dialog.confirm({
        title: '确认更换手机号',
        message: '换绑后新手机号将用于登录、下单联系、会员识别，确认继续？',
        confirmButtonText: '继续换绑',
        cancelButtonText: '再想想',
      });
      this.setData({ showRebindAuth: true });
    } catch (_err) {
      // 用户取消，保持原状
    }
  },

  /**
   * 微信手机号授权回调
   * 根据 maskedPhone 是否为空分派到首绑 / 换绑
   */
  async onGetPhoneNumber(e: WechatMiniprogram.TouchEvent) {
    const { cloudID, errMsg } = e.detail;
    const isRebind = !!this.data.maskedPhone;

    if (!cloudID) {
      if (errMsg?.includes('auth deny')) {
        Toast.fail('您拒绝了授权');
      } else if (errMsg) {
        Toast.fail(errMsg);
      }
      // 换绑时用户拒绝或取消 → 回到非授权状态，下次需要再次二次确认
      if (isRebind) this.setData({ showRebindAuth: false });
      return;
    }

    const app = getApp<IAppOption>();

    try {
      if (isRebind) {
        const { phone } = await rebindPhoneWithCloudID(cloudID as string);
        const newMasked = maskPhone(phone);
        wx.setStorageSync('phone', phone);
        if (app.globalData.userInfo) {
          (app.globalData.userInfo as any).phone = phone;
        }
        this.setData({ maskedPhone: newMasked, showRebindAuth: false });
        Toast.success(`已换绑至 ${newMasked}`);
      } else {
        const { phone } = await bindPhoneWithCloudID(cloudID as string);
        const newMasked = maskPhone(phone);
        wx.setStorageSync('phone', phone);
        if (app.globalData.userInfo) {
          (app.globalData.userInfo as any).phone = phone;
        }
        this.setData({ maskedPhone: newMasked });
        Toast.success('绑定成功');
      }
    } catch (err: any) {
      // 换绑失败 → 重置 showRebindAuth 以便用户重新走二次确认
      if (isRebind) this.setData({ showRebindAuth: false });
      const errorType = err?.errorType;
      if (errorType === 'PHONE_BOUND_BY_OTHER_USER') {
        Toast.fail('该手机号已被其他微信账号绑定');
      } else if (errorType === 'PHONE_HAS_EXISTING_PROFILE') {
        Dialog.alert({
          title: '无法直接换绑',
          message: '该手机号在系统中已存在消费档案，请联系门店协助处理。',
          confirmButtonText: '我知道了',
        });
      } else {
        Toast.fail(err.message || (isRebind ? '换绑失败' : '绑定失败'));
      }
    }
  },
});
