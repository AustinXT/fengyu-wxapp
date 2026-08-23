import { randomUUID } from "crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { lakalaOnboardingApplications, lakalaOnboardingRequestLogs } from "@db/lakala-onboarding";
import { lakalaQueryChannelSubMerchants, maskPayload } from "@/lib/lakala-onboarding";
import type { Db } from "../run";

const SUB_MERCHANT_POLL_TIMEOUT_MS = 72 * 60 * 60 * 1000;

function hasWechatSubMerchant(channelData: Record<string, unknown>) {
  return Array.isArray(channelData.wechat) && channelData.wechat.some((item) => {
    if (!item || typeof item !== "object") return false;
    return Boolean((item as Record<string, unknown>).subMerchantNo);
  });
}

function hasAlipaySubMerchant(channelData: Record<string, unknown>) {
  return Array.isArray(channelData.alipay) && channelData.alipay.some((item) => {
    if (!item || typeof item !== "object") return false;
    return Boolean((item as Record<string, unknown>).subMerchantNo);
  });
}

export async function refreshLakalaSubMerchants(db: Db) {
  await db.execute(sql`ALTER TABLE lakala_onboarding_applications ADD COLUMN IF NOT EXISTS channel_data JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await db.execute(sql`ALTER TABLE lakala_onboarding_applications ADD COLUMN IF NOT EXISTS sub_merchant_checked_at TIMESTAMPTZ`);
  const applications = await db.select({
    id: lakalaOnboardingApplications.id,
    storeId: lakalaOnboardingApplications.storeId,
    merchantNo: lakalaOnboardingApplications.merCupNo,
    innerNo: lakalaOnboardingApplications.merInnerNo,
    merchantData: lakalaOnboardingApplications.merchantData,
    terminalData: lakalaOnboardingApplications.terminalData,
    lakalaMerchantId: lakalaOnboardingApplications.lakalaMerchantId,
    channelData: lakalaOnboardingApplications.channelData,
    submittedAt: lakalaOnboardingApplications.submittedAt,
    updatedAt: lakalaOnboardingApplications.updatedAt,
  })
    .from(lakalaOnboardingApplications)
    .where(and(eq(lakalaOnboardingApplications.status, "SUCCESS"), isNotNull(lakalaOnboardingApplications.merCupNo)));
  let checked = 0;
  let found = 0;
  let timeout = 0;
  let certificationChecked = 0;
  let certificationDone = 0;
  for (const app of applications) {
    if (!app.merchantNo?.startsWith("82")) continue;
    const current = (app.channelData as Record<string, unknown>) || {};
    if (hasWechatSubMerchant(current) && hasAlipaySubMerchant(current)) {
      continue;
    }
    const polling = current.subMerchantPolling && typeof current.subMerchantPolling === "object"
      ? current.subMerchantPolling as Record<string, unknown>
      : null;
    if (polling?.status === "TIMEOUT") continue;
    const pollStartedAt = app.submittedAt ?? app.updatedAt;
    const elapsedMs = Date.now() - pollStartedAt.getTime();
    if (elapsedMs > SUB_MERCHANT_POLL_TIMEOUT_MS) {
      timeout++;
      await db.update(lakalaOnboardingApplications).set({
      channelData: {
        ...current,
        subMerchantPolling: {
          status: "TIMEOUT",
          stoppedAt: new Date().toISOString(),
          reason: "已自动查询 72 小时，微信/支付宝子商户号仍未全部返回",
        },
      },
      subMerchantCheckedAt: new Date(),
      lastErrorMessage: "微信/支付宝子商户号 72 小时未全部返回，请联系拉卡拉确认渠道报备结果",
      }).where(eq(lakalaOnboardingApplications.id, app.id));
      continue;
    }
    const result = await lakalaQueryChannelSubMerchants({ merchantNo: app.merchantNo });
    checked++;
    await db.insert(lakalaOnboardingRequestLogs).values({
      id: `ol_cron_${randomUUID()}`,
      applicationId: app.id,
      apiName: "tkbs.open_merchant_submer",
      requestId: randomUUID(),
      requestPayloadMasked: maskPayload({ merchant_no: app.merchantNo }),
      responsePayload: result.raw,
      success: result.success,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    });
    if (!result.success) continue;
    const channelData = {
      ...current,
      wechat: result.wechat,
      alipay: result.alipay,
      subMerchantPolling: {
        status: result.wechat.length && result.alipay.length ? "DONE" : "WAITING",
        lastCheckedAt: new Date().toISOString(),
        reason: result.wechat.length && result.alipay.length ? "已获取微信/支付宝子商户号" : "微信/支付宝子商户号暂未全部返回，等待下次自动查询",
      },
    };
    await db.update(lakalaOnboardingApplications).set({ channelData, subMerchantCheckedAt: new Date(), lastErrorMessage: null }).where(eq(lakalaOnboardingApplications.id, app.id));
    if (result.wechat.length) found++;
  }
  return { checked, found, timeout, certificationChecked, certificationDone };
}
