import { callClientApi } from '../../utils/cloud';

/**
 * 自动定位：获取当前城市名（地级市，不含"市"字）
 * 流程：wx.getLocation() → store.geocode 云函数 → 城市名
 * @returns Promise<string> 城市名，如 "南昌"
 * @throws 用户拒绝或定位失败时抛出错误
 */
export async function getCurrentCity(): Promise<string> {
  // 1. 获取 GPS 坐标
  const location = await new Promise<{ latitude: number; longitude: number }>((resolve, reject) => {
    wx.getLocation({
      type: 'gcj02',
      success: (res) => resolve({ latitude: res.latitude, longitude: res.longitude }),
      fail: reject,
    });
  });

  // 2. 调用云函数逆地理编码
  const data = await callClientApi<{ city: string }>('store.geocode', {
    latitude: location.latitude,
    longitude: location.longitude,
  });

  const city: string = data?.city || '';
  if (!city) throw new Error('未获取到城市信息');
  return city;
}
