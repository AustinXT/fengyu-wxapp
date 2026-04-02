import { callClientApi } from '../../utils/cloud';

export interface LocationResult {
  province: string;
  city: string;      // 去"市"后缀，如 "南昌"
  district: string;  // 保留原始格式，如 "东湖区"
  latitude: number;
  longitude: number;
}

/**
 * 自动定位：获取当前位置的省/市/区
 * 流程：wx.getFuzzyLocation() → store.geocode 云函数(TMAP_KEY 签名) → 位置信息
 */
export async function getCurrentLocation(): Promise<LocationResult> {
  // 1. 获取模糊 GPS 坐标 (gcj02)
  const { latitude, longitude } = await new Promise<{ latitude: number; longitude: number }>((resolve, reject) => {
    wx.getFuzzyLocation({
      type: 'gcj02',
      success: (res) => resolve({ latitude: res.latitude, longitude: res.longitude }),
      fail: reject,
    });
  });

  // 2. 调用云函数逆地理编码
  const data = await callClientApi<{ province: string; city: string; district: string }>('store.geocode', {
    latitude,
    longitude,
  });

  const city = data?.city || '';
  if (!city) throw new Error('未获取到城市信息');

  return {
    province: data?.province || '',
    city,
    district: data?.district || '',
    latitude,
    longitude,
  };
}

/**
 * 向后兼容：仅返回城市名
 */
export async function getCurrentCity(): Promise<string> {
  const loc = await getCurrentLocation();
  return loc.city;
}
