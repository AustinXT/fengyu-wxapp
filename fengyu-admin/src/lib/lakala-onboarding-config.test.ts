import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  getEContractOrgId,
  getLakalaBaseUrl,
  getLakalaOnboardingApiFamily,
  getLakalaOnboardingClientMode,
  getLakalaOnboardingEnv,
  getOnboardingActivityId,
  getOnboardingAppId,
  getOnboardingMcc,
  getOnboardingSerialNo,
  getOnboardingSettlementType,
  getOnboardingSm4Key,
  getOnboardingSource,
  getOnboardingUserNo,
  getOrgCode,
  verifyOnboardingSm4Key,
} from "./lakala-onboarding";

const keys = [
  "LAKALA_API_FAMILY",
  "LAKALA_CLIENT_MODE",
  "LAKALA_ENV",
  "LAKALA_APPID",
  "LAKALA_SERIAL_NO",
  "LAKALA_SM4_KEY",
  "LAKALA_ORG_CODE",
  "LAKALA_USER_NO",
  "LAKALA_ACTIVITY_ID",
  "LAKALA_MCC",
  "LAKALA_SETTLEMENT_TYPE",
  "LAKALA_SOURCE",
  "LAKALA_ONBOARDING_API_BASE",
  "LAKALA_ONBOARDING_APPID",
  "LAKALA_ONBOARDING_ORG_CODE",
] as const;

const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of keys) delete process.env[key];
});

afterAll(() => {
  for (const key of keys) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("拉卡拉门店入网统一环境变量", () => {
  it("共享支付侧模式、凭据和商户参数", () => {
    Object.assign(process.env, {
      LAKALA_API_FAMILY: "mms",
      LAKALA_CLIENT_MODE: "real",
      LAKALA_ENV: "prod",
      LAKALA_APPID: "payment-app",
      LAKALA_SERIAL_NO: "payment-serial",
      LAKALA_SM4_KEY: "1234567890abcdef",
      LAKALA_ORG_CODE: "org-1",
      LAKALA_USER_NO: "user-1",
      LAKALA_ACTIVITY_ID: "activity-1",
      LAKALA_MCC: "13002",
      LAKALA_SETTLEMENT_TYPE: "AUTOMATIC",
      LAKALA_SOURCE: "H5",
      LAKALA_ONBOARDING_API_BASE: "https://onboarding.example.com",
    });

    expect(getLakalaOnboardingApiFamily()).toBe("mms");
    expect(getLakalaOnboardingClientMode()).toBe("real");
    expect(getLakalaOnboardingEnv()).toBe("prod");
    expect(getLakalaBaseUrl()).toBe("https://onboarding.example.com");
    expect(getOnboardingAppId()).toBe("payment-app");
    expect(getOnboardingSerialNo()).toBe("payment-serial");
    expect(getOnboardingSm4Key()).toBe("1234567890abcdef");
    expect(getOrgCode()).toBe("org-1");
    expect(getEContractOrgId()).toBe("org-1");
    expect(getOnboardingUserNo()).toBe("user-1");
    expect(getOnboardingActivityId()).toBe("activity-1");
    expect(getOnboardingMcc()).toBe("13002");
    expect(getOnboardingSettlementType()).toBe("AUTOMATIC");
    expect(getOnboardingSource()).toBe("H5");
    expect(() => verifyOnboardingSm4Key()).not.toThrow();
  });

  it("不再读取重复的 ONBOARDING 凭据 key", () => {
    process.env.LAKALA_ONBOARDING_APPID = "legacy-app";
    process.env.LAKALA_ONBOARDING_ORG_CODE = "legacy-org";

    expect(getOnboardingAppId()).toBe("");
    expect(getOrgCode()).toBe("");
    expect(getEContractOrgId()).toBe("");
  });
});
