/**
 * 定位工具函数
 * 使用 wx.chooseLocation() 获取用户选择的位置，直接返回城市名
 */

/**
 * 打开地图让用户选择位置
 * @returns Promise<{ latitude: number, longitude: number, city: string }>
 */
export function chooseLocation(): Promise<{ latitude: number; longitude: number; city: string }> {
  return new Promise((resolve, reject) => {
    wx.chooseLocation({
      success(res) {
        resolve({
          latitude: res.latitude,
          longitude: res.longitude,
          city: res.city || '',
        });
      },
      fail(err) {
        reject(err);
      },
    });
  });
}

/**
 * 综合定位函数：获取用户当前城市
 * @returns Promise<string> 城市名
 * @throws 用户取消或拒绝时抛出错误
 */
export async function getCurrentCity(): Promise<string> {
  const location = await chooseLocation();
  if (!location.city) {
    throw new Error('未获取到城市信息');
  }
  return location.city;
}
