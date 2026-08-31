import { randomUUID } from "crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { lakalaOnboardingApplications, lakalaOnboardingRequestLogs } from "@db/lakala-onboarding";
import { lakalaQueryChannelSubMerchants } from "@/lib/lakala-onboarding";
import type { Db } from "../run";

const SUB_MERCHANT_POLL_TIMEOUT_MS = 72 * 60 * 60 * 1000;
const SUB_MERCHANT_BATCH_LIMIT = 100;

export interface RefreshLakalaSubMerchantsResult {
  eligible: number;
  checked: number;
  completed: number;
  failed: number;
  timedOut: number;
  skippedDisabled: boolean;
}

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

export async function refreshLakalaSubMerchants(db: Db): Promise<RefreshLakalaSubMerchantsResult> {
  if (process.env.LAKALA_ONBOARDING_ENABLED !== "true") {
    return { eligible: 0, checked: 0, completed: 0, failed: 0, timedOut: 0, skippedDisabled: true };
  }
  await db.execute(sql`ALTER TABLE lakala_onboarding_applications ADD COLUMN IF NOT EXISTS channel_data JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await db.execute(sql`ALTER TABLE lakala_onboarding_applications ADD COLUMN IF NOT EXISTS sub_merchant_checked_at TIMESTAMPTZ`);
  const applications = await db.select({
    id: lakalaOnboardingApplications.id,
    storeId: lakalaOnboardingApplications.storeId,
    merCupNo: lakalaOnboardingApplications.merCupNo,
    merInnerNo: lakalaOnboardingApplications.merInnerNo,
    merchantData: lakalaOnboardingApplications.merchantData,
    terminalData: lakalaOnboardingApplications.terminalData,
    lakalaMerchantId: lakalaOnboardingApplications.lakalaMerchantId,
    channelData: lakalaOnboardingApplications.channelData,
    submittedAt: lakalaOnboardingApplications.submittedAt,
    updatedAt: lakalaOnboardingApplications.updatedAt,
  })
    .from(lakalaOnboardingApplications)
    .where(and(
      eq(lakalaOnboardingApplications.status, "SUCCESS"),
      isNotNull(lakalaOnboardingApplications.merCupNo),
      sql`(channel_data->>'subMerchantPolling'->>'status' IS NULL OR channel_data->>'subMerchantPolling'->>'status' NOT IN ('DONE', 'TIMEOUT'))`,
    ))
    .orderBy(sql`sub_merchant_checked_at NULLS FIRST`, lakalaOnboardingApplications.updatedAt)
    .limit(SUB_MERCHANT_BATCH_LIMIT);

  let eligible = 0;
  let checked = 0;
  let completed = 0;
  let failed = 0;
  let timedOut = 0;

  for (const app of applications) {
    if (!app.merCupNo) continue;
    eligible++;
    const current = (app.channelData as Record<string, unknown>) || {};
    if (hasWechatSubMerchant(current) && hasAlipaySubMerchant(current)) {
      continue;
    }
    const polling = current.subMerchantPolling && typeof current.subMerchantPolling === "object"
      ? current.subMerchantPolling as Record<string, unknown>
      : null;
    if (polling?.status === "TIMEOUT") continue;
    const pollStartedAt = app.updatedAt ?? app.submittedAt;
    const elapsedMs = Date.now() - pollStartedAt.getTime();
    if (elapsedMs > SUB_MERCHANT_POLL_TIMEOUT_MS) {
      timedOut++;
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
        lastErrorCode: "SUB_MERCHANT_POLL_TIMEOUT",
        lastErrorMessage: "微信/支付宝子商户号 72 小时未全部返回，请联系拉卡拉确认渠道报备结果",
      }).where(eq(lakalaOnboardingApplications.id, app.id));
      continue;
    }
    const result = await lakalaQueryChannelSubMerchants({ merchantNo: app.merCupNo });
    checked++;
    const maskedMerchantNo = app.merCupNo ? `${app.merCupNo.slice(0, 2)}***` : "";
    await db.insert(lakalaOnboardingRequestLogs).values({
      id: `ol_cron_${randomUUID()}`,
      applicationId: app.id,
      apiName: "tkbs.open_merchant_submer",
      requestId: randomUUID(),
      requestPayloadMasked: { merchant_no: maskedMerchantNo },
      responsePayload: {
        success: result.success,
        wechatCount: result.wechat?.length ?? 0,
        alipayCount: result.alipay?.length ?? 0,
      },
      success: result.success,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    });
    const bothReady = result.success && result.wechat.length > 0 && result.alipay.length > 0;
    const status = bothReady ? "DONE" : "WAITING";
    const reason = bothReady
      ? "已获取微信/支付宝子商户号"
      : !result.success
        ? result.errorMessage || "渠道查询失败，等待下次自动查询"
        : "微信/支付宝子商户号暂未全部返回，等待下次自动查询";
    const channelData = {
      ...current,
      wechat: result.wechat,
      alipay: result.alipay,
      subMerchantPolling: {
        status,
        startedAt: pollStartedAt.toISOString(),
        lastCheckedAt: new Date().toISOString(),
        reason,
      },
    };
    await db.update(lakalaOnboardingApplications).set({
      channelData,
      subMerchantCheckedAt: new Date(),
      lastErrorCode: result.success ? null : (result.errorCode ?? null),
      lastErrorMessage: result.success ? null : (result.errorMessage ?? null),
    }).where(eq(lakalaOnboardingApplications.id, app.id));
    if (!result.success) {
      failed++;
      continue;
    }
    if (bothReady) completed++;
  }
  return { eligible, checked, completed, failed, timedOut, skippedDisabled: false };
}
