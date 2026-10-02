// 只接收微信授权凭据；手机号必须由微信服务端返回。
async function resolvePhone(cloud, payload = {}) {
  const { code, cloudID } = payload;
  let data;
  if (typeof code === "string" && code && code.length <= 512) {
    const result = await cloud.openapi.phonenumber.getPhoneNumber({ code });
    data = result.phoneInfo;
  } else if (typeof cloudID === "string" && cloudID && cloudID.length <= 2048) {
    // 使用服务端 SDK 获取开放数据，不信任客户端传入的解密对象。
    const result = await cloud.getOpenData({ list: [cloudID] });
    data = result.list?.[0];
    if (data?.watermark?.appid && data.watermark.appid !== "wx4da3e1e9ad861396")
      throw new Error("UNAUTHORIZED: 请使用日报小程序的手机号授权");
  } else {
    throw new Error("INVALID_PARAMS: 请重新授权手机号");
  }
  const phone = data?.purePhoneNumber;
  if (typeof phone !== "string" || !/^1\d{10}$/.test(phone))
    throw new Error("INVALID_PARAMS: 请使用有效的微信手机号授权");
  return phone;
}
module.exports = { resolvePhone };
