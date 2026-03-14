// pagesProfile/profile-edit/profile-edit.ts
import Toast from '@vant/weapp/toast/toast';
import { maskPhone } from '../../utils/format';

async function callClientApi(action: string, payload: Record<string, any> = {}) {
  const res = await wx.cloud.callFunction({
    name: 'clientApi',
    data: { action, payload }
  }) as any;
  if (res.result?.code !== 0) {
    const err: any = new Error(res.result?.message || '请求失败');
    err.code = res.result?.code;
    throw err;
  }
  return res.result.data;
}

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
      const ext = tempFilePath.split('.').pop() || 'jpg';
      const cloudPath = `avatars/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

      const uploadRes = await wx.cloud.uploadFile({
        cloudPath,
        filePath: tempFilePath,
      });
      const fileID = uploadRes.fileID;

      await callClientApi('auth.updateProfile', { avatarUrl: fileID });
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
      Toast('昵称不能为空');
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
   * 换绑手机号
   */
  async onGetPhoneNumber(e: WechatMiniprogram.TouchEvent) {
    const { cloudID, errMsg } = e.detail;
    if (!cloudID) {
      if (errMsg?.includes('auth deny')) {
        Toast('您拒绝了授权');
      }
      return;
    }

    try {
      wx.showLoading({ title: '绑定中...', mask: true });
      const res = await wx.cloud.callFunction({
        name: 'clientApi',
        data: {
          action: 'auth.bindPhone',
          payload: {},
          phoneData: wx.cloud.CloudID(cloudID as string)
        }
      }) as any;
      wx.hideLoading();

      if (res.result?.code !== 0) {
        throw new Error(res.result?.message || '绑定失败');
      }

      const { phone } = res.result.data;
      wx.setStorageSync('phone', phone);
      this.setData({ maskedPhone: maskPhone(phone) });

      const tips = res.result.data.updatedOrdersCount > 0
        ? `已同步 ${res.result.data.updatedOrdersCount} 笔历史订单`
        : '绑定成功';
      Toast.success(tips);
    } catch (err: any) {
      wx.hideLoading();
      Toast.fail(err.message || '绑定失败');
    }
  },
});
