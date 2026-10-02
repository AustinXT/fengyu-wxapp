const test = require("node:test");
const assert = require("node:assert/strict");
const { resolvePhone } = require("../utils/phone-auth");

test("一次性 code 优先，由微信服务端兑换手机号", async () => {
  const cloud = {
    openapi: {
      phonenumber: {
        getPhoneNumber: async (args) => {
          assert.deepEqual(args, { code: "weixin-code" });
          return { phoneInfo: { purePhoneNumber: "13800000000" } };
        },
      },
    },
    getOpenData: () => {
      throw Error("不应调用旧授权");
    },
  };
  assert.equal(
    await resolvePhone(cloud, { code: "weixin-code", cloudID: "old-id" }),
    "13800000000",
  );
});

test("cloudID 从服务端读取开放数据，忽略客户端伪造手机号", async () => {
  const cloud = {
    getOpenData: async (args) => {
      assert.deepEqual(args, { list: ["trusted-id"] });
      return {
        list: [
          {
            purePhoneNumber: "13800000000",
            watermark: { appid: "wx4da3e1e9ad861396" },
          },
        ],
      };
    },
  };
  assert.equal(
    await resolvePhone(cloud, {
      cloudID: "trusted-id",
      purePhoneNumber: "13900000000",
    }),
    "13800000000",
  );
});

test("拒绝客户端直接手机号或已解密对象", async () => {
  for (const payload of [
    { purePhoneNumber: "13800000000" },
    { cloudID: { purePhoneNumber: "13800000000" } },
    { code: "x".repeat(513) },
  ]) {
    await assert.rejects(resolvePhone({}, payload), /INVALID_PARAMS:/);
  }
});

test("拒绝其他小程序的开放数据和无效手机号", async () => {
  await assert.rejects(
    resolvePhone(
      {
        getOpenData: async () => ({
          list: [
            {
              purePhoneNumber: "13800000000",
              watermark: { appid: "other-app" },
            },
          ],
        }),
      },
      { cloudID: "id" },
    ),
    /UNAUTHORIZED:/,
  );
  await assert.rejects(
    resolvePhone(
      { getOpenData: async () => ({ list: [] }) },
      { cloudID: "id" },
    ),
    /INVALID_PARAMS:/,
  );
});
