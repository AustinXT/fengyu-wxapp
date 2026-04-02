// @ts-ignore — 无类型声明的 JS SDK
import QQMapWX from './qqmap-wx-jssdk.min';

/** Tencent LBS Key — 仅授权给 appid wx811eb4ded3dfba3f */
const LBS_KEY = 'EGIBZ-QAEKQ-XQ557-B23AA-RFYIK-FCB47';

const qqmapsdk = new QQMapWX({ key: LBS_KEY });

export interface LocationResult {
  province: string;
  city: string;      // 去"市"后缀，如 "南昌"
  district: string;  // 保留原始格式，如 "东湖区"
  latitude: number;
  longitude: number;
}

/**
 * 自动定位：获取当前位置的省/市/区
 * 流程：wx.getFuzzyLocation() → qqmap-wx-jssdk 逆地理编码 → 位置信息
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

  // 2. qqmap-wx-jssdk 逆地理编码
  const ac = await new Promise<any>((resolve, reject) => {
    qqmapsdk.reverseGeocoder({
      location: { latitude, longitude },
      success: (res: any) => {
        resolve(res.result?.address_component || {});
      },
      fail: (err: any) => {
        reject(new Error(err?.message || '逆地理编码失败'));
      },
    });
  });

  const city = (ac.city || '').replace(/市$/, '');
  if (!city) throw new Error('未获取到城市信息');

  return {
    province: ac.province || '',
    city,
    district: ac.district || '',
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
