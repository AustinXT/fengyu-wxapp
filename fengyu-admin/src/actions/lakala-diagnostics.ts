"use server";

import { createPrivateKey } from "crypto";
import { URL } from "url";
import { withPermission } from "@/lib/with-permission";
import {
  getLakalaBaseUrl,
  getLakalaOnboardingApiFamily,
  getLakalaOnboardingClientMode,
  getLakalaOnboardingEnv,
  getOnboardingActivityId,
  getOnboardingSm4Key,
  getOnboardingUserNo,
  getOrgCode,
  verifyOnboardingSm4Key,
} from "@/lib/lakala-onboarding";

export type LakalaDiagnosticStatus = "ok" | "warn" | "error";

export type LakalaDiagnosticItem = {
  key: string;
  label: string;
  status: LakalaDiagnosticStatus;
  value: string;
  detail?: string;
};

export type LakalaDiagnostics = {
  generatedAt: string;
  summary: LakalaDiagnosticStatus;
  items: LakalaDiagnosticItem[];
};

function boolItem(key: string, label: string, exists: boolean, okText = "已配置", missingText = "未配置"): LakalaDiagnosticItem {
  return {
    key,
    label,
    status: exists ? "ok" : "error",
    value: exists ? okText : missingText,
  };
}

function envValue(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return { name, value };
  }
  return null;
}

function safeHost(value: string) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return value ? "格式异常" : "未配置";
  }
}

async function checkPrivateKey(): Promise<LakalaDiagnosticItem> {
  const pem = envValue("LAKALA_PRIVATE_KEY_PEM");
  try {
    const key = pem?.value || "";
    if (!key) {
      return { key: "privateKey", label: "商户私钥", status: "error", value: "未配置" };
    }
    createPrivateKey(key.replace(/\\n/g, "\n"));
    return {
      key: "privateKey",
      label: "商户私钥",
      status: "ok",
      value: `${pem?.name ?? "LAKALA_PRIVATE_KEY_PEM"} 已配置且可解析`,
    };
  } catch (error) {
    return {
      key: "privateKey",
      label: "商户私钥",
      status: "error",
      value: "不可用",
      detail: error instanceof Error ? error.message : "私钥解析失败",
    };
  }
}

async function checkPlatformCert(): Promise<LakalaDiagnosticItem> {
  const pem = envValue("LAKALA_PLATFORM_CERT_PEM");
  if (pem) return { key: "platformCert", label: "平台证书", status: "ok", value: `${pem.name} 已配置` };
  return { key: "platformCert", label: "平台证书", status: "warn", value: "未配置", detail: "当前代码提交签名暂未使用平台证书，但真实验签/回调验签时会需要。" };
}

async function checkGatewayReachable(baseUrl: string): Promise<LakalaDiagnosticItem> {
  try {
    const url = new URL(baseUrl);
    const response = await fetch(`${url.protocol}//${url.host}`, {
      method: "HEAD",
      signal: AbortSignal.timeout(3500),
    });
    return {
      key: "gatewayReachable",
      label: "网关连通性",
      status: "ok",
      value: `HTTP ${response.status}`,
      detail: "能连到网关域名；业务接口是否通过仍以 tkbs 文件上传/进件返回为准。",
    };
  } catch (error) {
    return {
      key: "gatewayReachable",
      label: "网关连通性",
      status: "warn",
      value: "未确认",
      detail: error instanceof Error ? error.message : "访问网关失败；可能是网络、DNS、白名单或网关不支持 HEAD。",
    };
  }
}

function checkSm4Key(): LakalaDiagnosticItem {
  try {
    verifyOnboardingSm4Key();
    const source = envValue("LAKALA_SM4_KEY");
    return { key: "sm4Key", label: "SM4 加密密钥", status: "ok", value: `${source?.name ?? "SM4 配置"} 已配置且可用` };
  } catch (error) {
    return {
      key: "sm4Key",
      label: "SM4 加密密钥",
      status: "error",
      value: getOnboardingSm4Key() ? "不可用" : "未配置",
      detail: error instanceof Error ? error.message : "merchant_encry 需要 LAKALA_SM4_KEY",
    };
  }
}

export const getLakalaDiagnostics = withPermission("system:config", async (): Promise<LakalaDiagnostics> => {
  const mode = getLakalaOnboardingClientMode();
  const env = getLakalaOnboardingEnv();
  const baseUrl = getLakalaBaseUrl();
  const family = getLakalaOnboardingApiFamily();
  const callback = envValue("LAKALA_ECONTRACT_CALLBACK_URL");
  const appId = envValue("LAKALA_APPID");
  const serialNo = envValue("LAKALA_SERIAL_NO");

  const items: LakalaDiagnosticItem[] = [
    {
      key: "apiFamily",
      label: "接口体系",
      status: family === "tkbs" ? "ok" : "warn",
      value: family,
      detail: family === "tkbs" ? "后台入网使用拓客商服 API，并复用支付侧凭据。" : "当前仍为旧 mms 接口，仅兼容历史测试。",
    },
    {
      key: "clientMode",
      label: "调用模式",
      status: mode === "real" ? "ok" : "warn",
      value: mode,
      detail: mode === "real"
        ? "后台入网会真实请求拉卡拉接口。"
        : "后台入网当前不会请求拉卡拉，只会走本地 mock。",
    },
    {
      key: "environment",
      label: "拉卡拉环境",
      status: env === "test" ? "ok" : "warn",
      value: env,
      detail: env === "test" ? "后台入网当前指向测试环境。" : "后台入网当前指向生产环境，提交前请谨慎确认。",
    },
    {
      key: "baseUrl",
      label: "网关地址",
      status: baseUrl ? "ok" : "error",
      value: safeHost(baseUrl),
      detail: "仅显示协议和域名，不展示完整敏感参数。",
    },
    {
      key: "orgCode",
      label: "机构号",
      status: getOrgCode() ? "ok" : "error",
      value: getOrgCode() ? "LAKALA_ORG_CODE 已配置" : "未配置",
    },
    boolItem("appId", "应用 ID", Boolean(appId), appId ? `${appId.name} 已配置` : "已配置"),
    boolItem("serialNo", "商户证书序列号", Boolean(serialNo), serialNo ? `${serialNo.name} 已配置` : "已配置"),
    boolItem("userNo", "归属用户 user_no", Boolean(getOnboardingUserNo()), getOnboardingUserNo() ? "LAKALA_USER_NO 已配置" : "已配置"),
    boolItem("activityId", "活动 ID", Boolean(getOnboardingActivityId()), getOnboardingActivityId() ? "LAKALA_ACTIVITY_ID 已配置" : "已配置"),
    boolItem("callback", "回调地址", Boolean(callback), callback ? `${callback.name} 已配置` : "已配置"),
    await checkPrivateKey(),
    await checkPlatformCert(),
    checkSm4Key(),
    await checkGatewayReachable(baseUrl),
  ];

  const summary: LakalaDiagnosticStatus = items.some((item) => item.status === "error")
    ? "error"
    : items.some((item) => item.status === "warn")
      ? "warn"
      : "ok";

  return {
    generatedAt: new Date().toISOString(),
    summary,
    items,
  };
});
