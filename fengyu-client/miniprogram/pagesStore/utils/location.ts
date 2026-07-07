import { callClientApi } from '../../utils/cloud';

export interface LocationResult {
  province: string;
  city: string;      
  district: string;  
  latitude: number;
  longitude: number;
}


export async function getCurrentLocation(): Promise<LocationResult> {
  
  const { latitude, longitude } = await new Promise<{ latitude: number; longitude: number }>((resolve, reject) => {
    wx.getFuzzyLocation({
      type: 'gcj02',
      success: (res) => resolve({ latitude: res.latitude, longitude: res.longitude }),
      fail: reject,
    });
  });

  
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


export async function getCurrentCity(): Promise<string> {
  const loc = await getCurrentLocation();
  return loc.city;
}
