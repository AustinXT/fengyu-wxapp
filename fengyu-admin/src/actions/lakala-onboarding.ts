"use server"

import { randomBytes, randomUUID } from "crypto";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";
import { revalidatePath } from "next/cache";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { withPermission } from "@/lib/with-permission";
import { logOperation } from "@/lib/operation-log";
import { pgErrorCode } from "@/lib/pg-error";
import { lakalaMerchants } from "@db/lakala";
import { orgNodes, stores } from "@db/org";
import {
  lakalaOnboardingApplications,
  lakalaOnboardingAttachments,
  lakalaOnboardingRequestLogs,
} from "@db/lakala-onboarding";
import { businessErrorMessage } from "@/lib/action-error";
import {
  AGREEMENT_ATTACHMENT,
  ATTACHMENT_REQUIREMENTS,
  DEFAULT_FEE_DATA,
  DEFAULT_LAKALA_VALUES,
  getPrivateUploadRoot,
  getOnboardingActivityId,
  getOnboardingBusiCode,
  getOnboardingEmail,
  getOnboardingLatitude,
  getOnboardingLongtude,
  getOnboardingMcc,
  getOnboardingSettlementType,
  getOnboardingSource,
  getOnboardingUserNo,
  getEContractCallbackUrl,
  getEContractOrgId,
  getEContractType,
  getLakalaOnboardingApiFamily,
  getLakalaOnboardingClientMode,
  getMerchantBusinessContent,
  getOrgCode,
  lakalaAddMerchant,
  lakalaApplyElectronicContract,
  lakalaQueryOcrResult,
  lakalaQueryBanks,
  lakalaQuerySubMerchant,
  lakalaQueryChannelSubMerchants,
  lakalaQueryMerchantAuthState,
  lakalaUploadFile,
  maskPayload,
  MAX_ONBOARDING_ATTACHMENT_BYTES,
  minimalPdf,
  normalizeTkbsAttachmentType,
  findLocalLakalaBankAreaCodes,
  queryLocalLakalaBanksByAreaKeywords,
  resolveLocalLakalaMerchantRegionByCode,
  savePrivateOnboardingFile,
  type ChannelSubMerchantResult,
  type MerchantAuthStateResult,
  verifyOnboardingSm4Key,
} from "@/lib/lakala-onboarding";
import { areaCodeFromAddress, getAreaPathByCode } from "@/lib/china-area";
import { bufferToUploadFileLike, type UploadFileLike } from "@/lib/upload-file";

type JsonRecord = Record<string, string>;

export type OnboardingStatus =
  | "DRAFT"
  | "FILES_UPLOADING"
  | "FILES_READY"
  | "SUBMITTING"
  | "SUBMITTED"
  | "REGISTERING"
  | "SUCCESS"
  | "FAILED"
  | "CANCELLED";

export type OnboardingApplicationInput = {
  merchantData: JsonRecord;
  legalPersonData: JsonRecord;
  contactData: JsonRecord;
  settlementData: JsonRecord;
  shopData: JsonRecord;
  terminalData: JsonRecord;
};

export type OnboardingListItem = {
  id: string;
  orderNo: string;
  storeId: string;
  storeName: string;
  marketName: string | null;
  subjectName: string;
  status: OnboardingStatus;
  missing: string | null;
  owner: string | null;
  updatedAt: string;
  merCupNo: string | null;
  terminalNo: string | null;
  lakalaMerchantId: string | null;
  lakalaMerchantEnabled: boolean | null;
  channelData: Record<string, unknown>;
  subMerchantCheckedAt: string | null;
};

export type OnboardingStoreOption = {
  storeId: string;
  storeName: string;
  marketName: string | null;
  hasCollectionMerchant: boolean;
  activeApplicationId: string | null;
};

export type OnboardingBankOption = {
  branchBankNo: string;
  clearNo: string;
  branchBankName: string;
  areaCode?: string;
  bankNo?: string;
};

export type OnboardingAttachment = {
  id: string;
  displayName: string;
  attType: string;
  fileName: string;
  mimeType: string | null;
  previewUrl: string | null;
  status: string;
  attFileId: string | null;
  lakalaFileUrl: string | null;
  lakalaShowUrl: string | null;
  lakalaBatchNo: string | null;
  lakalaOcrStatus: string | null;
  expiresAt: string | null;
  lastErrorMessage: string | null;
};

export type OnboardingDetail = OnboardingListItem & {
  merchantData: JsonRecord;
  legalPersonData: JsonRecord;
  contactData: JsonRecord;
  settlementData: JsonRecord;
  shopData: JsonRecord;
  terminalData: JsonRecord;
  eContractOrderNo: string | null;
  eContractApplyId: string | null;
  eContractResultUrl: string | null;
  eContractNo: string | null;
  eContractStatus: string | null;
  contractId: string | null;
  merInnerNo: string | null;
  merCupNo: string | null;
  channelData: Record<string, unknown>;
  subMerchantCheckedAt: string | null;
  lastErrorMessage: string | null;
  attachments: OnboardingAttachment[];
  requestLogs: Array<{
    id: string;
    apiName: string;
    success: boolean;
    errorMessage: string | null;
    createdAt: string;
  }>;
};

let schemaReady = false;

function ksuid(prefix: string): string {
  const ts = Math.floor(Date.now() / 1000).toString(36).padStart(8, "0");
  const rand = randomBytes(6).toString("hex");
  return `${prefix}${ts}${rand}`;
}

function todayOrderNo() {
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  return `ONB-${ymd}-${String(Math.floor(Date.now() % 10000)).padStart(4, "0")}`;
}

async function ensureOnboardingSchema() {
  if (schemaReady) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS lakala_onboarding_applications (
      id TEXT PRIMARY KEY,
      order_no TEXT NOT NULL UNIQUE,
      store_id TEXT NOT NULL REFERENCES stores(store_id) ON DELETE RESTRICT ON UPDATE CASCADE,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      merchant_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      legal_person_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      contact_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      settlement_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      shop_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      terminal_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      fee_data JSONB NOT NULL DEFAULT '[]'::jsonb,
      lakala_request_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      contract_id TEXT,
      mer_inner_no TEXT,
      mer_cup_no TEXT,
      lakala_merchant_id TEXT,
      last_error_code TEXT,
      last_error_message TEXT,
      submitted_at TIMESTAMPTZ,
      created_by TEXT,
      created_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS lakala_onboarding_attachments (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES lakala_onboarding_applications(id) ON DELETE CASCADE ON UPDATE CASCADE,
      att_type TEXT NOT NULL,
      display_name TEXT NOT NULL,
      local_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_ext TEXT,
      file_size TEXT NOT NULL,
      mime_type TEXT,
      status TEXT NOT NULL DEFAULT 'LOCAL_SAVED',
      att_file_id TEXT,
      lakala_file_url TEXT,
      lakala_show_url TEXT,
      lakala_batch_no TEXT,
      lakala_ocr_status TEXT,
      uploaded_to_lakala_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      last_error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`ALTER TABLE lakala_onboarding_attachments ADD COLUMN IF NOT EXISTS lakala_file_url TEXT`);
  await db.execute(sql`ALTER TABLE lakala_onboarding_attachments ADD COLUMN IF NOT EXISTS lakala_show_url TEXT`);
  await db.execute(sql`ALTER TABLE lakala_onboarding_attachments ADD COLUMN IF NOT EXISTS lakala_batch_no TEXT`);
  await db.execute(sql`ALTER TABLE lakala_onboarding_attachments ADD COLUMN IF NOT EXISTS lakala_ocr_status TEXT`);
  await db.execute(sql`ALTER TABLE lakala_onboarding_applications ADD COLUMN IF NOT EXISTS e_contract_order_no TEXT`);
  await db.execute(sql`ALTER TABLE lakala_onboarding_applications ADD COLUMN IF NOT EXISTS e_contract_apply_id TEXT`);
  await db.execute(sql`ALTER TABLE lakala_onboarding_applications ADD COLUMN IF NOT EXISTS e_contract_result_url TEXT`);
  await db.execute(sql`ALTER TABLE lakala_onboarding_applications ADD COLUMN IF NOT EXISTS e_contract_no TEXT`);
  await db.execute(sql`ALTER TABLE lakala_onboarding_applications ADD COLUMN IF NOT EXISTS e_contract_status TEXT`);
  await db.execute(sql`ALTER TABLE lakala_onboarding_applications ADD COLUMN IF NOT EXISTS e_contract_signed_at TIMESTAMPTZ`);
  await db.execute(sql`ALTER TABLE lakala_onboarding_applications ADD COLUMN IF NOT EXISTS channel_data JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await db.execute(sql`ALTER TABLE lakala_onboarding_applications ADD COLUMN IF NOT EXISTS sub_merchant_checked_at TIMESTAMPTZ`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS lakala_onboarding_request_logs (
      id TEXT PRIMARY KEY,
      application_id TEXT REFERENCES lakala_onboarding_applications(id) ON DELETE SET NULL ON UPDATE CASCADE,
      api_name TEXT NOT NULL,
      request_id TEXT NOT NULL,
      request_payload_masked JSONB NOT NULL DEFAULT '{}'::jsonb,
      response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      success BOOLEAN NOT NULL,
      error_code TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_lakala_onboarding_store_id ON lakala_onboarding_applications(store_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_lakala_onboarding_status ON lakala_onboarding_applications(status)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_lakala_onboarding_active_store ON lakala_onboarding_applications(store_id) WHERE status NOT IN ('SUCCESS', 'FAILED', 'CANCELLED')`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_lakala_onboarding_attachments_app ON lakala_onboarding_attachments(application_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_lakala_onboarding_logs_app ON lakala_onboarding_request_logs(application_id)`);
  schemaReady = true;
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    DRAFT: "草稿",
    FILES_UPLOADING: "资料保存中",
    FILES_READY: "资料已保存",
    SUBMITTING: "提交中",
    SUBMITTED: "已提交",
    REGISTERING: "报备中",
    SUCCESS: "成功",
    FAILED: "失败",
    CANCELLED: "已取消",
  };
  return labels[status] || status;
}

type ChannelItem = ChannelSubMerchantResult["wechat"][number];

function getChannelItems(channelData: Record<string, unknown>, key: "wechat" | "alipay"): ChannelItem[] {
  const value = channelData[key];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const subMerchantNo = row.subMerchantNo;
    return typeof subMerchantNo === "string" && subMerchantNo
      ? [{
          subMerchantNo,
          registerType: typeof row.registerType === "string" ? row.registerType : "",
          channelId: typeof row.channelId === "string" ? row.channelId : "",
          registerChannelName: typeof row.registerChannelName === "string" ? row.registerChannelName : "",
        }]
      : [];
  });
}

function hasWechatSubMerchant(channelData: Record<string, unknown>) {
  return getChannelItems(channelData, "wechat").length > 0;
}

function hasAlipaySubMerchant(channelData: Record<string, unknown>) {
  return getChannelItems(channelData, "alipay").length > 0;
}

function getStoredTerminalNo(terminalData: unknown) {
  if (!terminalData || typeof terminalData !== "object") return "";
  const data = terminalData as Record<string, unknown>;
  const value = data.termNo ?? data.terminalNo ?? data.term_no;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

type OnboardingTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * 申请单 → 收款商户 upsert 的唯一实现（enable / associate 两条路径共用）。
 * 守卫逻辑（跨市场、防抹 NULL、fallback 商户核验）只在此处维护一份。
 */
async function upsertMerchantForApplication(
  tx: OnboardingTx,
  app: Pick<
    NonNullable<Awaited<ReturnType<typeof getOnboardingApplicationForService>>>,
    "storeId" | "merCupNo" | "lakalaMerchantId"
  >,
  params: { enabled: boolean; merchantName: string; merchantNo: string | null; terminalNo: string },
): Promise<{ merchantId: string } | { error: string }> {
  const [storeRow] = await tx
    .select({ storeId: stores.storeId, orgNodeId: stores.orgNodeId })
    .from(stores)
    .where(eq(stores.storeId, app.storeId))
    .limit(1);

  const [marketRow] = storeRow?.orgNodeId
    ? await tx
        .select({ marketOrgNodeId: orgNodes.parentId })
        .from(orgNodes)
        .where(eq(orgNodes.id, storeRow.orgNodeId))
        .limit(1)
    : [];
  const marketOrgNodeId = marketRow?.marketOrgNodeId ?? null;

  const existingByMerchantNo = app.merCupNo
    ? await tx
        .select({ id: lakalaMerchants.id, marketOrgNodeId: lakalaMerchants.marketOrgNodeId })
        .from(lakalaMerchants)
        .where(eq(lakalaMerchants.merchantNo, app.merCupNo))
        .limit(1)
    : [];
  const existing = existingByMerchantNo[0];

  if (existing) {
    if (existing.marketOrgNodeId && marketOrgNodeId && existing.marketOrgNodeId !== marketOrgNodeId) {
      return { error: "拉卡拉商户已属于其他市场，不能跨市场绑定" };
    }
    // 门店侧市场解析为 NULL（门店未挂市场等脏数据）时不允许覆写，防止把已归属市场的商户抹成 NULL
    if (existing.marketOrgNodeId && !marketOrgNodeId) {
      return { error: "门店未归属市场，无法变更已归属市场的收款商户" };
    }
    // existing 市场为 NULL（含市场节点被删后的残留）：允许本次写入收编归属
  }

  // 商户号是拉卡拉侧的权威键：existing 按 merCupNo 命中时以它为准（跨市场检查也是对它做的），避免"检查 existing、写入 app.lakalaMerchantId"的错位
  const merchantId = existing?.id ?? app.lakalaMerchantId ?? ksuid("lm_");

  if (!existing && app.lakalaMerchantId) {
    // 兜底复用申请单旧关联商户前核验其归属（防商户管理页手工改号/改市场造成的带外错配）
    const [fallbackRow] = await tx
      .select({ merchantNo: lakalaMerchants.merchantNo, marketOrgNodeId: lakalaMerchants.marketOrgNodeId })
      .from(lakalaMerchants)
      .where(eq(lakalaMerchants.id, app.lakalaMerchantId))
      .limit(1);
    if (!fallbackRow) {
      return { error: "申请单关联的收款商户记录不存在，请在收款商户页核实后重试" };
    }
    if (app.merCupNo && fallbackRow.merchantNo && fallbackRow.merchantNo !== app.merCupNo) {
      return { error: "申请单商户号与关联收款商户不一致，不能复用旧关联商户" };
    }
    if (fallbackRow.marketOrgNodeId && marketOrgNodeId && fallbackRow.marketOrgNodeId !== marketOrgNodeId) {
      return { error: "拉卡拉商户已属于其他市场，不能跨市场绑定" };
    }
    if (fallbackRow.marketOrgNodeId && !marketOrgNodeId) {
      return { error: "门店未归属市场，无法变更已归属市场的收款商户" };
    }
  }

  if (existing || app.lakalaMerchantId) {
    await tx.update(lakalaMerchants).set({
      merchantName: params.merchantName,
      merchantNo: params.merchantNo,
      termNo: params.terminalNo,
      enabled: params.enabled,
      marketOrgNodeId,
    }).where(eq(lakalaMerchants.id, merchantId));
  } else {
    await tx.insert(lakalaMerchants).values({
      id: merchantId,
      merchantName: params.merchantName,
      merchantNo: params.merchantNo,
      termNo: params.terminalNo,
      enabled: params.enabled,
      marketOrgNodeId,
    });
  }
  await tx.update(stores).set({ lakalaMerchantId: merchantId }).where(eq(stores.storeId, app.storeId));
  return { merchantId };
}

async function associateDisabledMerchantForApplication(
  tx: OnboardingTx,
  app: NonNullable<Awaited<ReturnType<typeof getOnboardingApplicationForService>>>,
): Promise<{ merchantId: string } | { error: string }> {
  const data = mergeInput({
    merchantData: app.merchantData as JsonRecord,
    legalPersonData: app.legalPersonData as JsonRecord,
    contactData: app.contactData as JsonRecord,
    settlementData: app.settlementData as JsonRecord,
    shopData: app.shopData as JsonRecord,
    terminalData: app.terminalData as JsonRecord,
  });
  const merchantName = data.merchantData.merRegName || data.merchantData.merBlisName || data.merchantData.subjectName || data.merchantData.merBizName || app.orderNo;
  const terminalNo = getStoredTerminalNo(app.terminalData);
  if (!app.merCupNo?.startsWith("82")) throw new Error("INVALID_STATE: 缺少银联商户号，不能关联收款商户");
  if (!terminalNo) throw new Error("INVALID_STATE: 缺少终端号，不能关联收款商户");
  const channelData = (app.channelData as Record<string, unknown>) ?? {};
  if (!hasWechatSubMerchant(channelData)) throw new Error("INVALID_STATE: 缺少微信子商户号，不能关联收款商户");
  if (!hasAlipaySubMerchant(channelData)) throw new Error("INVALID_STATE: 缺少支付宝子商户号，不能关联收款商户");
  return upsertMerchantForApplication(tx, app, {
    enabled: false,
    merchantName,
    merchantNo: app.merCupNo,
    terminalNo,
  });
}

async function refreshChannelSubMerchantsForApplication(applicationId: string, merchantNo: string): Promise<ChannelSubMerchantResult> {
  const result = await lakalaQueryChannelSubMerchants({ merchantNo });
  await writeLog({
    applicationId,
    apiName: "tkbs.open_merchant_submer",
    requestPayload: { merchant_no: merchantNo, org_code: getOrgCode() },
    responsePayload: result.raw,
    success: result.success,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
  });
  if (!result.success) {
    await db.update(lakalaOnboardingApplications).set({
      subMerchantCheckedAt: new Date(),
      lastErrorCode: result.errorCode ?? null,
      lastErrorMessage: result.errorMessage ?? "子商户号查询失败，请稍后手动重试",
    }).where(eq(lakalaOnboardingApplications.id, applicationId));
    return result;
  }
  const [currentApp] = await db
    .select({ channelData: lakalaOnboardingApplications.channelData })
    .from(lakalaOnboardingApplications)
    .where(eq(lakalaOnboardingApplications.id, applicationId))
    .limit(1);
  const current = (currentApp?.channelData as Record<string, unknown>) ?? {};
  const currentWechat = getChannelItems(current, "wechat");
  const currentAlipay = getChannelItems(current, "alipay");
  const wechatReturnedEmpty = result.wechat.length === 0;
  const alipayReturnedEmpty = result.alipay.length === 0;
  const wechat = wechatReturnedEmpty ? currentWechat : result.wechat;
  const alipay = alipayReturnedEmpty ? currentAlipay : result.alipay;
  const bothReady = wechat.length > 0 && alipay.length > 0;
  // 拉卡拉查询成功但某渠道空返回、旧号只是被沿用兜底：可能已被撤销，须提示核实而非静默保留
  const possiblyRevoked = (wechatReturnedEmpty && currentWechat.length > 0) || (alipayReturnedEmpty && currentAlipay.length > 0);
  await db.update(lakalaOnboardingApplications).set({
    channelData: {
      ...current,
      wechat,
      alipay,
    },
    subMerchantCheckedAt: new Date(),
    lastErrorCode: null,
    lastErrorMessage: possiblyRevoked
      ? "拉卡拉本次查询未返回部分子商户号，原有子商户号可能已被撤销，请与拉卡拉核实"
      : bothReady ? null : "尚有渠道未返回子商户号，请稍后手动查询",
  }).where(eq(lakalaOnboardingApplications.id, applicationId));
  return { ...result, wechat, alipay };
}

function emptyInput(): OnboardingApplicationInput {
  return {
    merchantData: {},
    legalPersonData: {},
    contactData: {},
    settlementData: {},
    shopData: {},
    terminalData: { salesStaff: "邵冬" },
  };
}

function mergeInput(input?: Partial<OnboardingApplicationInput>): OnboardingApplicationInput {
  const empty = emptyInput();
  const data = {
    merchantData: { ...empty.merchantData, ...(input?.merchantData ?? {}) },
    legalPersonData: { ...empty.legalPersonData, ...(input?.legalPersonData ?? {}) },
    contactData: { ...empty.contactData, ...(input?.contactData ?? {}) },
    settlementData: { ...empty.settlementData, ...(input?.settlementData ?? {}) },
    shopData: { ...empty.shopData, ...(input?.shopData ?? {}) },
    terminalData: { ...empty.terminalData, ...(input?.terminalData ?? {}) },
  };
  return normalizeApplicationInput(data);
}

function normalizeApplicationInput(input: OnboardingApplicationInput): OnboardingApplicationInput {
  // 历史草稿仅保存了 subjectName，须兼容回填；新草稿中的主体名称和营业执照名称可独立维护。
  const subjectName = input.merchantData.merRegName || input.merchantData.subjectName || input.merchantData.merBlisName;
  const businessLicenseName = input.merchantData.merBlisName || subjectName;
  const businessName = input.merchantData.merBizName || input.shopData.shopName;
  const merchantData: JsonRecord = {
    ...input.merchantData,
    ...(subjectName ? { subjectName, merRegName: subjectName } : {}),
    ...(businessLicenseName ? { merBlisName: businessLicenseName } : {}),
    ...(businessName ? { merBizName: businessName } : {}),
  };
  const shopData = {
    ...input.shopData,
    shopName: input.shopData.shopName || merchantData.merBizName || merchantData.merRegName || "",
    shopDistCode: input.shopData.shopDistCode || merchantData.merRegDistCode || "",
    shopAddr: input.shopData.shopAddr || merchantData.merRegAddr || "",
    shopContactName: input.shopData.shopContactName || input.contactData.merContactName || input.legalPersonData.larName || "",
    shopContactMobile: input.shopData.shopContactMobile || input.contactData.merContactMobile || "",
  };
  return {
    ...input,
    merchantData,
    shopData,
    settlementData: {
      ...input.settlementData,
      acctName: input.settlementData.acctName || subjectName || "",
    },
  };
}

function licenseExpiryForSubmit(merchantData: JsonRecord) {
  return merchantData.merBlisLongTerm === "true" ? "9999-12-31" : merchantData.merBlisExpDt;
}

function idCardExpiryForSubmit(legalPersonData: JsonRecord) {
  return legalPersonData.larIdcardLongTerm === "true" ? "9999-12-31" : legalPersonData.larIdcardExpDt;
}

function missingFromData(data: OnboardingApplicationInput) {
  const normalized = normalizeApplicationInput(data);
  const missing: string[] = [];
  if (!normalized.merchantData.merRegName || !normalized.merchantData.merBlis || !normalized.merchantData.merBlisStDt || !licenseExpiryForSubmit(normalized.merchantData)) missing.push("主体证照");
  if (!normalized.merchantData.merRegDistCode || !normalized.merchantData.merRegAddr) missing.push("注册地址");
  if (!normalized.legalPersonData.larName || !normalized.legalPersonData.larIdcard || !normalized.legalPersonData.larIdcardStDt || !idCardExpiryForSubmit(normalized.legalPersonData)) missing.push("法人信息");
  if (!normalized.contactData.merContactName || !normalized.contactData.merContactMobile) missing.push("联系人");
  if (
    !normalized.settlementData.acctName ||
    !normalized.settlementData.acctNo ||
    !normalized.settlementData.bankDistCode ||
    !normalized.settlementData.bankAreaCode ||
    !normalized.settlementData.openningBankCode ||
    !normalized.settlementData.openningBankName ||
    !normalized.settlementData.clearingBankCode
  ) missing.push("结算账户");
  return missing;
}

function requiredData(app: NonNullable<Awaited<ReturnType<typeof getOnboardingApplicationForService>>>) {
  const data = mergeInput({
    merchantData: app.merchantData as JsonRecord,
    legalPersonData: app.legalPersonData as JsonRecord,
    contactData: app.contactData as JsonRecord,
    settlementData: app.settlementData as JsonRecord,
    shopData: app.shopData as JsonRecord,
    terminalData: app.terminalData as JsonRecord,
  });
  const missing = missingFromData(data);
  if (missing.length) throw new Error(`INVALID_PARAMS: 提交前请先补齐：${missing.join("、")}`);
  return data;
}

async function getOnboardingApplicationForService(id: string): Promise<any> {
  await ensureOnboardingSchema();
  const [row] = await db
    .select({
      app: lakalaOnboardingApplications,
      storeName: stores.storeName,
      marketName: sql<string | null>`(
        SELECT parent.name
        FROM org_nodes node
        LEFT JOIN org_nodes parent ON parent.id = node.parent_id
        WHERE node.id = ${stores.orgNodeId}
      )`,
      lakalaMerchantEnabled: sql<boolean | null>`(
        SELECT lm.enabled
        FROM lakala_merchants lm
        WHERE lm.id = ${lakalaOnboardingApplications.lakalaMerchantId}
        LIMIT 1
      )`,
    })
    .from(lakalaOnboardingApplications)
    .innerJoin(stores, eq(stores.storeId, lakalaOnboardingApplications.storeId))
    .where(eq(lakalaOnboardingApplications.id, id))
    .limit(1);
  if (!row) return null;
  return {
    ...row.app,
    storeName: row.storeName,
    marketName: row.marketName,
    lakalaMerchantEnabled: row.lakalaMerchantEnabled ?? false,
  };
}

async function getOnboardingApplicationFromDb(id: string) {
  await ensureOnboardingSchema();
  const [app] = await db
    .select()
    .from(lakalaOnboardingApplications)
    .where(eq(lakalaOnboardingApplications.id, id))
    .limit(1);
  return app ?? null;
}

async function writeLog(params: {
  applicationId?: string;
  apiName: string;
  requestPayload: unknown;
  responsePayload: unknown;
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
}) {
  await ensureOnboardingSchema();
  await db.insert(lakalaOnboardingRequestLogs).values({
    id: ksuid("ol_"),
    applicationId: params.applicationId,
    apiName: params.apiName,
    requestId: randomUUID(),
    requestPayloadMasked: maskPayload(params.requestPayload),
    responsePayload: params.responsePayload as Record<string, unknown>,
    success: params.success,
    errorCode: params.errorCode,
    errorMessage: params.errorMessage,
  });
}

async function activeApplicationForStore(storeId: string) {
  const rows = await db
    .select({ id: lakalaOnboardingApplications.id })
    .from(lakalaOnboardingApplications)
    .where(and(
      eq(lakalaOnboardingApplications.storeId, storeId),
      sql`${lakalaOnboardingApplications.status} NOT IN ('SUCCESS', 'FAILED', 'CANCELLED')`,
    ))
    .limit(1);
  return rows[0]?.id ?? null;
}

function mapAttachment(row: typeof lakalaOnboardingAttachments.$inferSelect): OnboardingAttachment {
  const canPreview = Boolean(row.mimeType?.startsWith("image/") || row.mimeType === "application/pdf");
  return {
    id: row.id,
    displayName: row.displayName,
    attType: row.attType,
    fileName: row.fileName,
    mimeType: row.mimeType ?? null,
    previewUrl: canPreview ? `/api/merchants/onboarding/${row.applicationId}/attachments/${row.id}` : null,
    status: row.status,
    attFileId: row.attFileId ?? null,
    lakalaFileUrl: row.lakalaFileUrl ?? null,
    lakalaShowUrl: row.lakalaShowUrl ?? null,
    lakalaBatchNo: row.lakalaBatchNo ?? null,
    lakalaOcrStatus: row.lakalaOcrStatus ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastErrorMessage: row.lastErrorMessage ?? null,
  };
}

export const getOnboardingStoreOptions = withPermission(
  "merchant:list",
  async (session): Promise<OnboardingStoreOption[]> => {
    await ensureOnboardingSchema();
    const visibleIds = session.permissions.scopeStoreIds;
    const rows = await db
      .select({
        storeId: stores.storeId,
        storeName: stores.storeName,
        lakalaMerchantId: stores.lakalaMerchantId,
        marketName: sql<string | null>`(
          SELECT parent.name
          FROM org_nodes node
          LEFT JOIN org_nodes parent ON parent.id = node.parent_id
          WHERE node.id = ${stores.orgNodeId}
        )`,
      })
      .from(stores)
      .where(visibleIds.length ? inArray(stores.storeId, visibleIds) : sql`FALSE`)
      .orderBy(asc(stores.storeName));
    const activeRows = await db
      .select({ id: lakalaOnboardingApplications.id, storeId: lakalaOnboardingApplications.storeId })
      .from(lakalaOnboardingApplications)
      .where(sql`${lakalaOnboardingApplications.status} NOT IN ('SUCCESS', 'FAILED', 'CANCELLED')`);
    const activeMap = new Map(activeRows.map((row) => [row.storeId, row.id]));
    return rows.map((row) => ({
      storeId: row.storeId,
      storeName: row.storeName,
      marketName: row.marketName,
      hasCollectionMerchant: Boolean(row.lakalaMerchantId),
      activeApplicationId: activeMap.get(row.storeId) ?? null,
    }));
  },
);

export const listOnboardingApplications = withPermission(
  "merchant:list",
  async (session): Promise<OnboardingListItem[]> => {
    await ensureOnboardingSchema();
    const visibleIds = session.permissions.scopeStoreIds;
    const rows = await db
      .select({
        id: lakalaOnboardingApplications.id,
        orderNo: lakalaOnboardingApplications.orderNo,
        storeId: stores.storeId,
        storeName: stores.storeName,
        status: lakalaOnboardingApplications.status,
        merchantData: lakalaOnboardingApplications.merchantData,
        terminalData: lakalaOnboardingApplications.terminalData,
        merCupNo: lakalaOnboardingApplications.merCupNo,
        lakalaMerchantId: lakalaOnboardingApplications.lakalaMerchantId,
        lakalaMerchantEnabled: sql<boolean | null>`(
          SELECT lm.enabled
          FROM lakala_merchants lm
          WHERE lm.id = ${lakalaOnboardingApplications.lakalaMerchantId}
          LIMIT 1
        )`,
        channelData: lakalaOnboardingApplications.channelData,
        subMerchantCheckedAt: lakalaOnboardingApplications.subMerchantCheckedAt,
        updatedAt: lakalaOnboardingApplications.updatedAt,
        owner: lakalaOnboardingApplications.createdByName,
        marketName: sql<string | null>`(
          SELECT parent.name
          FROM org_nodes node
          LEFT JOIN org_nodes parent ON parent.id = node.parent_id
          WHERE node.id = ${stores.orgNodeId}
        )`,
      })
      .from(lakalaOnboardingApplications)
      .innerJoin(stores, eq(stores.storeId, lakalaOnboardingApplications.storeId))
      .where(visibleIds.length ? inArray(stores.storeId, visibleIds) : sql`FALSE`)
      .orderBy(desc(lakalaOnboardingApplications.updatedAt));
    return rows.map((row) => {
      const merchantData = (row.merchantData ?? {}) as JsonRecord;
      return {
        id: row.id,
        orderNo: row.orderNo,
        storeId: row.storeId,
        storeName: row.storeName,
        marketName: row.marketName,
        subjectName: merchantData.subjectName || merchantData.merBlisName || merchantData.merRegName || "未填写",
        status: row.status as OnboardingStatus,
        missing: row.status === "DRAFT" || row.status === "FILES_READY" ? "待确认资料" : null,
        owner: row.owner,
        updatedAt: row.updatedAt.toISOString(),
        merCupNo: row.merCupNo ?? null,
        terminalNo: getStoredTerminalNo(row.terminalData) || null,
        lakalaMerchantId: row.lakalaMerchantId ?? null,
        lakalaMerchantEnabled: row.lakalaMerchantEnabled ?? null,
        channelData: (row.channelData as Record<string, unknown>) ?? {},
        subMerchantCheckedAt: row.subMerchantCheckedAt?.toISOString() ?? null,
      };
    });
  },
);

export const getOnboardingApplication = withPermission(
  "merchant:list",
  async (_session, id: string): Promise<OnboardingDetail | null> => {
    await ensureOnboardingSchema();
    const [row] = await db
      .select({
        app: lakalaOnboardingApplications,
        storeName: stores.storeName,
        orgNodeId: stores.orgNodeId,
        lakalaMerchantEnabled: sql<boolean | null>`(
          SELECT lm.enabled
          FROM lakala_merchants lm
          WHERE lm.id = ${lakalaOnboardingApplications.lakalaMerchantId}
          LIMIT 1
        )`,
      })
      .from(lakalaOnboardingApplications)
      .innerJoin(stores, eq(stores.storeId, lakalaOnboardingApplications.storeId))
      .where(eq(lakalaOnboardingApplications.id, id))
      .limit(1);
    if (!row) return null;
    const [market] = row.orgNodeId
      ? await db.select({ name: orgNodes.name }).from(orgNodes).where(sql`${orgNodes.id} = (SELECT parent_id FROM org_nodes WHERE id = ${row.orgNodeId})`).limit(1)
      : [];
    const attachments = await db
      .select()
      .from(lakalaOnboardingAttachments)
      .where(eq(lakalaOnboardingAttachments.applicationId, id))
      .orderBy(desc(lakalaOnboardingAttachments.createdAt));
    const logs = await db
      .select()
      .from(lakalaOnboardingRequestLogs)
      .where(eq(lakalaOnboardingRequestLogs.applicationId, id))
      .orderBy(desc(lakalaOnboardingRequestLogs.createdAt))
      .limit(8);
    const data = mergeInput({
      merchantData: row.app.merchantData as JsonRecord,
      legalPersonData: row.app.legalPersonData as JsonRecord,
      contactData: row.app.contactData as JsonRecord,
      settlementData: row.app.settlementData as JsonRecord,
      shopData: row.app.shopData as JsonRecord,
      terminalData: row.app.terminalData as JsonRecord,
    });
    return {
      id: row.app.id,
      orderNo: row.app.orderNo,
      storeId: row.app.storeId,
      storeName: row.storeName,
      marketName: market?.name ?? null,
      subjectName: data.merchantData.subjectName || data.merchantData.merBlisName || data.merchantData.merRegName || "未填写",
      status: row.app.status as OnboardingStatus,
      missing: missingFromData(data).join("、") || null,
      owner: row.app.createdByName,
      updatedAt: row.app.updatedAt.toISOString(),
      ...data,
      eContractOrderNo: row.app.eContractOrderNo ?? null,
      eContractApplyId: row.app.eContractApplyId ?? null,
      eContractResultUrl: row.app.eContractResultUrl ?? null,
      eContractNo: row.app.eContractNo ?? null,
      eContractStatus: row.app.eContractStatus ?? null,
      contractId: row.app.contractId ?? null,
      merInnerNo: row.app.merInnerNo ?? null,
      merCupNo: row.app.merCupNo ?? null,
      terminalNo: getStoredTerminalNo(row.app.terminalData) || null,
      lakalaMerchantId: row.app.lakalaMerchantId ?? null,
      lakalaMerchantEnabled: row.lakalaMerchantEnabled ?? null,
      channelData: (row.app.channelData as Record<string, unknown>) ?? {},
      subMerchantCheckedAt: row.app.subMerchantCheckedAt?.toISOString() ?? null,
      lastErrorMessage: row.app.lastErrorMessage ?? null,
      attachments: attachments.map(mapAttachment),
      requestLogs: logs.map((log) => ({
        id: log.id,
        apiName: log.apiName,
        success: log.success,
        errorMessage: log.errorMessage ?? null,
        createdAt: log.createdAt.toISOString(),
      })),
    };
  },
);

export const createOnboardingApplication = withPermission(
  "merchant:create",
  async (session, storeId: string): Promise<{ success: boolean; message: string; id?: string }> => {
    await ensureOnboardingSchema();
    const [store] = await db
      .select({ storeId: stores.storeId, storeName: stores.storeName, lakalaMerchantId: stores.lakalaMerchantId })
      .from(stores)
      .where(eq(stores.storeId, storeId))
      .limit(1);
    if (!store) return { success: false, message: "门店不存在" };
    if (!session.permissions.scopeStoreIds.includes(storeId)) return { success: false, message: "无权为该门店发起入网" };
    if (store.lakalaMerchantId) return { success: false, message: "该门店已绑定收款商户，不能重复发起入网" };
    const active = await activeApplicationForStore(storeId);
    if (active) return { success: false, message: "该门店已有进行中的入网申请", id: active };

    const id = ksuid("onb_");
    const input = mergeInput({
      merchantData: {},
      shopData: { shopName: store.storeName },
    });
    try {
      await db.insert(lakalaOnboardingApplications).values({
        id,
        orderNo: todayOrderNo(),
        storeId,
        merchantData: input.merchantData,
        legalPersonData: input.legalPersonData,
        contactData: input.contactData,
        settlementData: input.settlementData,
        shopData: input.shopData,
        terminalData: input.terminalData,
        feeData: DEFAULT_FEE_DATA as unknown as Record<string, unknown>[],
        createdBy: session.employeeId,
        createdByName: session.name,
      });
    } catch (error) {
      if (pgErrorCode(error) === "23505") return { success: false, message: "该门店已有进行中的入网申请" };
      throw error;
    }
    await logOperation(session, "merchant.onboarding.create", "lakala_onboarding_application", id, { storeId });
    revalidatePath("/merchants");
    revalidatePath("/merchants/onboarding-prototype/new");
    return { success: true, message: "入网申请已创建", id };
  },
);

/**
 * 删除一条入网申请及其本机私有资料。
 *
 * 已生成/绑定的收款商户不在此处删除，避免影响门店已经正常使用的收款配置。
 */
export const deleteOnboardingApplication = withPermission(
  "merchant:delete",
  async (session, id: string): Promise<{ success: boolean; message: string }> => {
    if (!id) return { success: false, message: "申请不存在" };
    await ensureOnboardingSchema();

    const [application] = await db
      .select({
        id: lakalaOnboardingApplications.id,
        orderNo: lakalaOnboardingApplications.orderNo,
        storeId: lakalaOnboardingApplications.storeId,
        status: lakalaOnboardingApplications.status,
        lakalaMerchantId: lakalaOnboardingApplications.lakalaMerchantId,
      })
      .from(lakalaOnboardingApplications)
      .where(eq(lakalaOnboardingApplications.id, id))
      .limit(1);
    if (!application) return { success: false, message: "申请不存在或已删除" };
    if (!session.permissions.scopeStoreIds.includes(application.storeId)) {
      return { success: false, message: "无权删除该门店的入网申请" };
    }

    // 每个申请的私有附件均位于独立目录。只删除由应用编号推导出的目录，
    // 不信任数据库内的 localPath，避免异常数据导致误删任意服务器文件。
    const uploadRoot = getPrivateUploadRoot();
    const onboardingRoot = path.resolve(uploadRoot, "lakala-onboarding");
    const applicationUploadDir = path.resolve(onboardingRoot, application.id);
    if (!applicationUploadDir.startsWith(`${onboardingRoot}${path.sep}`)) {
      throw new Error("INVALID_STATE: 入网附件路径异常，已拒绝删除");
    }
    await rm(applicationUploadDir, { recursive: true, force: true });

    await db.transaction(async (tx) => {
      // 历史请求日志也属于该申请，删除前先清理，避免留下脱离申请的业务记录。
      await tx.delete(lakalaOnboardingRequestLogs).where(eq(lakalaOnboardingRequestLogs.applicationId, application.id));
      // 附件记录由外键 ON DELETE CASCADE 自动删除。
      await tx.delete(lakalaOnboardingApplications).where(eq(lakalaOnboardingApplications.id, application.id));
    });

    await logOperation(session, "merchant.onboarding.delete", "lakala_onboarding_application", application.id, {
      orderNo: application.orderNo,
      storeId: application.storeId,
      status: application.status,
      hadLinkedMerchant: Boolean(application.lakalaMerchantId),
    });
    revalidatePath("/merchants");
    revalidatePath("/merchants/onboarding-prototype");
    revalidatePath(`/merchants/onboarding-prototype/${application.id}`);
    return {
      success: true,
      message: application.lakalaMerchantId
        ? "入网申请及附件已删除；关联收款商户和门店绑定未变更"
        : "入网申请及附件已删除",
    };
  },
);

export const saveOnboardingApplication = withPermission(
  "merchant:update",
  async (session, id: string, input: OnboardingApplicationInput): Promise<{ success: boolean; message: string }> => {
    await ensureOnboardingSchema();
    const data = mergeInput(input);
    const [before] = await db.select().from(lakalaOnboardingApplications).where(eq(lakalaOnboardingApplications.id, id)).limit(1);
    if (!before) return { success: false, message: "申请不存在" };
    await db
      .update(lakalaOnboardingApplications)
      .set({
        // 已进入拉卡拉链路后，保存资料不能把审核状态覆盖回草稿。
        status: before.merInnerNo || before.merCupNo ? before.status : "DRAFT",
        merchantData: data.merchantData,
        legalPersonData: data.legalPersonData,
        contactData: data.contactData,
        settlementData: data.settlementData,
        shopData: data.shopData,
        terminalData: data.terminalData,
        feeData: DEFAULT_FEE_DATA as unknown as Record<string, unknown>[],
        ...(before.merInnerNo || before.merCupNo ? {} : { lastErrorCode: null, lastErrorMessage: null }),
      })
      .where(eq(lakalaOnboardingApplications.id, id));
    await logOperation(session, "merchant.onboarding.save", "lakala_onboarding_application", id, { orderNo: before.orderNo });
    revalidatePath(`/merchants/onboarding-prototype/${id}`);
    revalidatePath("/merchants");
    return { success: true, message: "草稿已保存" };
  },
);

async function syncFileReadyStatus(applicationId: string) {
  const app = await getOnboardingApplicationForService(applicationId);
  if (!app) return;
  const requiredNames = new Set<string>(ATTACHMENT_REQUIREMENTS.map((item) => item.displayName));
  for (const attachment of await db.select().from(lakalaOnboardingAttachments).where(eq(lakalaOnboardingAttachments.applicationId, applicationId))) {
    if (["LOCAL_SAVED", "UPLOADED"].includes(attachment.status)) requiredNames.delete(attachment.displayName);
  }
  if (requiredNames.size === 0 && !app.merInnerNo && !app.merCupNo) {
    await db.update(lakalaOnboardingApplications).set({ status: "FILES_READY" }).where(eq(lakalaOnboardingApplications.id, applicationId));
  }
}

function formatAttachmentSize(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function onboardingAttachmentTooLargeMessage(displayName: string, bytes: number) {
  return `${displayName}：文件过大（${formatAttachmentSize(bytes)}），请压缩到 5MB 内后重新上传`;
}

export const uploadOnboardingAttachment = withPermission(
  "merchant:update",
  async (_session, applicationId: string, file: UploadFileLike, attType: string, displayName: string) => {
  await ensureOnboardingSchema();
  const app = await getOnboardingApplicationForService(applicationId);
  if (!app) throw new Error("NOT_FOUND: 申请不存在");
  if (typeof file.size === "number" && file.size > MAX_ONBOARDING_ATTACHMENT_BYTES) {
    throw new Error(`INVALID_PARAMS: ${onboardingAttachmentTooLargeMessage(displayName, file.size)}`);
  }
  if (!app.merInnerNo && !app.merCupNo) {
    await db.update(lakalaOnboardingApplications).set({ status: "FILES_UPLOADING", lastErrorCode: null, lastErrorMessage: null }).where(eq(lakalaOnboardingApplications.id, applicationId));
  }
  const saved = await savePrivateOnboardingFile(applicationId, file);
  const attachmentId = ksuid("oa_");
  await db
    .delete(lakalaOnboardingAttachments)
    .where(and(eq(lakalaOnboardingAttachments.applicationId, applicationId), eq(lakalaOnboardingAttachments.displayName, displayName)));
  await db.insert(lakalaOnboardingAttachments).values({
    id: attachmentId,
    applicationId,
    attType,
    displayName,
    localPath: saved.fullPath,
    fileName: saved.fileName,
    fileExt: saved.fileExt,
    fileSize: String(saved.fileSize),
    mimeType: saved.mimeType,
    status: "LOCAL_SAVED",
    attFileId: null,
    lakalaFileUrl: null,
    lakalaShowUrl: null,
    lakalaBatchNo: null,
    lakalaOcrStatus: null,
    uploadedToLakalaAt: null,
    expiresAt: null,
    lastErrorMessage: null,
  });
  await syncFileReadyStatus(applicationId);
  revalidatePath(`/merchants/onboarding-prototype/${applicationId}`);
    return { success: true, message: `${displayName} 已保存` };
  },
);

export const generateAndUploadAgreement = withPermission(
  "merchant:update",
  async (_session, applicationId: string): Promise<{ success: boolean; message: string }> => {
    await ensureOnboardingSchema();
    const app = await getOnboardingApplicationForService(applicationId);
    if (!app) return { success: false, message: "申请不存在" };
    const uploadRoot = getPrivateUploadRoot();
    const dir = path.join(uploadRoot, "lakala-onboarding", applicationId);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `agreement-${Date.now()}.pdf`);
    const buffer = minimalPdf([
      "Lakala agreement placeholder",
      `Order No: ${app.orderNo}`,
      `Generated At: ${new Date().toISOString()}`,
      "Final template and signature requirements are pending confirmation.",
    ].join("\n"));
    await writeFile(filePath, buffer);
    const file = bufferToUploadFileLike(buffer, path.basename(filePath), "application/pdf");
    await uploadOnboardingAttachment(applicationId, file, AGREEMENT_ATTACHMENT.attType, AGREEMENT_ATTACHMENT.displayName);
    return { success: true, message: "电子协议已生成，提交时会上传拉卡拉" };
  },
);

async function uploadAttachmentToLakala(app: NonNullable<Awaited<ReturnType<typeof getOnboardingApplicationForService>>>, attachment: typeof lakalaOnboardingAttachments.$inferSelect) {
  const lakalaAttType = normalizeTkbsAttachmentType(attachment.attType, attachment.displayName);
  const shouldRefreshType = attachment.attType !== lakalaAttType || attachment.attFileId?.includes(attachment.attType) || attachment.lakalaFileUrl?.includes(attachment.attType);
  if (
    !shouldRefreshType &&
    attachment.status === "UPLOADED" &&
    (attachment.lakalaFileUrl || attachment.attFileId) &&
    attachment.expiresAt &&
    attachment.expiresAt.getTime() > Date.now()
  ) {
    return { type: lakalaAttType, id: attachment.lakalaFileUrl || attachment.attFileId || "" };
  }
  const storedFileSize = Number(attachment.fileSize || 0);
  if (storedFileSize > MAX_ONBOARDING_ATTACHMENT_BYTES) {
    const message = onboardingAttachmentTooLargeMessage(attachment.displayName, storedFileSize);
    await db
      .update(lakalaOnboardingAttachments)
      .set({ status: "FAILED", lastErrorMessage: message })
      .where(eq(lakalaOnboardingAttachments.id, attachment.id));
    throw new Error(`INVALID_PARAMS: ${message}`);
  }
  const buffer = await readFile(attachment.localPath);
  await db
    .update(lakalaOnboardingAttachments)
    .set({ status: "UPLOADING", lastErrorMessage: null })
    .where(eq(lakalaOnboardingAttachments.id, attachment.id));
  const uploadPayload = {
    orderNo: app.orderNo,
    attType: lakalaAttType,
    attExtName: attachment.fileExt || "bin",
    attContext: buffer.toString("base64"),
  };
  const result = await lakalaUploadFile({ applicationId: app.id, ...uploadPayload });
  await writeLog({
    applicationId: app.id,
    apiName: "tkbs.customer.file.upload",
    requestPayload: uploadPayload,
    responsePayload: result.raw,
    success: result.success,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
  });
  if (!result.success || !(result.fileUrl || result.attFileId)) {
    const message = result.errorMessage || "附件上传拉卡拉失败";
    await db
      .update(lakalaOnboardingAttachments)
      .set({ status: "FAILED", lastErrorMessage: message })
      .where(eq(lakalaOnboardingAttachments.id, attachment.id));
    throw new Error(`INVALID_STATE: ${attachment.displayName}：${message}`);
  }
  const uploadedAt = new Date();
  const expiresAt = new Date(uploadedAt.getTime() + 24 * 60 * 60 * 1000);
  await db
    .update(lakalaOnboardingAttachments)
    .set({
      status: "UPLOADED",
      attType: lakalaAttType,
      attFileId: result.fileUrl || result.attFileId,
      lakalaFileUrl: result.fileUrl || result.attFileId || null,
      lakalaShowUrl: result.showUrl || null,
      lakalaBatchNo: result.batchNo || null,
      lakalaOcrStatus: result.ocrStatus || null,
      uploadedToLakalaAt: uploadedAt,
      expiresAt,
      lastErrorMessage: null,
    })
    .where(eq(lakalaOnboardingAttachments.id, attachment.id));
  if (result.ocrStatus === "01" && result.batchNo) {
    const ocrResult = await lakalaQueryOcrResult({ imgType: lakalaAttType, batchNo: result.batchNo });
    await writeLog({
      applicationId: app.id,
      apiName: "tkbs.ocr_result",
      requestPayload: { imgType: lakalaAttType, batchNo: result.batchNo },
      responsePayload: ocrResult.raw,
      success: ocrResult.success,
      errorCode: ocrResult.errorCode,
      errorMessage: ocrResult.errorMessage,
    });
    await db
      .update(lakalaOnboardingAttachments)
      .set({
        lakalaShowUrl: ocrResult.showUrl || result.showUrl || null,
        lakalaOcrStatus: ocrResult.ocrStatus || result.ocrStatus || null,
        lastErrorMessage: ocrResult.success ? null : ocrResult.errorMessage || "OCR 结果查询失败",
      })
      .where(eq(lakalaOnboardingAttachments.id, attachment.id));
  }
  return { type: lakalaAttType, id: result.fileUrl || result.attFileId || "" };
}

async function validateAndUploadAttachments(app: NonNullable<Awaited<ReturnType<typeof getOnboardingApplicationForService>>>) {
  const now = Date.now();
  const missing = new Set<string>(ATTACHMENT_REQUIREMENTS.map((item) => item.displayName));
  const fileData: Array<{ type: string; id: string }> = [];
  const attachments = await db.select().from(lakalaOnboardingAttachments).where(eq(lakalaOnboardingAttachments.applicationId, app.id));
  const latestByName = new Map<string, typeof lakalaOnboardingAttachments.$inferSelect>();
  for (const attachment of attachments) {
    if (!latestByName.has(attachment.displayName)) latestByName.set(attachment.displayName, attachment);
  }
  for (const displayName of missing) {
    const attachment = latestByName.get(displayName);
    if (!attachment || !["LOCAL_SAVED", "UPLOADING", "UPLOADED", "FAILED"].includes(attachment.status)) continue;
    if (attachment.status === "UPLOADED" && attachment.expiresAt && attachment.expiresAt.getTime() < now) {
      await db
        .update(lakalaOnboardingAttachments)
        .set({ status: "LOCAL_SAVED", attFileId: null, lakalaFileUrl: null, lakalaShowUrl: null, lakalaBatchNo: null, lakalaOcrStatus: null, uploadedToLakalaAt: null, expiresAt: null })
        .where(eq(lakalaOnboardingAttachments.id, attachment.id));
    }
    missing.delete(displayName);
  }
  if (missing.size > 0) throw new Error(`INVALID_PARAMS: 缺少必传附件：${Array.from(missing).join("、")}`);
  for (const displayName of ATTACHMENT_REQUIREMENTS.map((item) => item.displayName)) {
    const attachment = latestByName.get(displayName);
    if (!attachment) continue;
    fileData.push(await uploadAttachmentToLakala(app, attachment));
  }
  return fileData;
}

function normalizeDateForLakala(value?: string) {
  return (value || "").replace(/\//g, "-");
}

function requireOnboardingConfig(name: string, value: string) {
  if (!value) throw new Error(`INVALID_STATE: 缺少后台入网配置：${name}`);
  return value;
}

function provinceCodeFromCounty(countyCode: string) {
  return countyCode.length >= 2 ? `${countyCode.slice(0, 2)}0000` : countyCode;
}

function cityCodeFromCounty(countyCode: string) {
  return countyCode.length >= 4 ? `${countyCode.slice(0, 4)}00` : countyCode;
}

function envOrData(envName: string, value?: string) {
  return process.env[envName] || value || "";
}

function tkbsBankCityCode(openningBankCode?: string) {
  const digits = (openningBankCode || "").replace(/\D/g, "");
  // CNAPS 联行号通常形如 102421006241，其中第 4-7 位是地区码；
  // 拓客商服示例也使用该体系：103614010818 -> city_code 6140。
  return digits.length >= 7 ? digits.slice(3, 7) : "";
}

function resolveOpeningBankName(settlementData: JsonRecord) {
  const code = settlementData.openningBankCode || settlementData.clearingBankCode || "";
  const name = settlementData.openningBankName || "";
  const knownBankNames: Record<string, string> = {
    "102421006241": "中国工商银行南昌红谷滩支行",
    "308421000013": "招商银行股份有限公司南昌分行",
    "105421000013": "中国建设银行南昌市分行",
  };
  if (name && name !== code) return name;
  return knownBankNames[code] || name || code;
}

function tkbsProvinceCodeFromCity(cityCode: string) {
  return cityCode.length >= 2 ? `${cityCode.slice(0, 2)}00` : "";
}

function tkbsCountyCodeFromCity(cityCode: string) {
  // 文档样例：柳州 city_code=6140，county_code=986140。
  return cityCode.length === 4 ? `98${cityCode}` : "";
}

function provinceNameFromAreaLabel(label: string) {
  return label.match(/^(.+?(?:省|自治区|市|特别行政区))/)?.[1] || "";
}

function cityNameFromAreaLabel(label: string) {
  const withoutProvince = label.replace(/^.+?(?:省|自治区|特别行政区)/, "");
  return withoutProvince.match(/^(.+?市)/)?.[1] || "";
}

function countyNameFromAreaLabel(label: string) {
  const provinceName = provinceNameFromAreaLabel(label);
  const cityName = cityNameFromAreaLabel(label);
  return label.replace(provinceName, "").replace(cityName, "");
}

function stripAreaSuffix(value: string) {
  return value.replace(/(特别行政区|自治州|自治县|自治区|新区|地区|盟|省|市|区|县)$/g, "");
}

function areaKeywordsFromAreaLabel(label: string) {
  const cityName = cityNameFromAreaLabel(label);
  const countyName = countyNameFromAreaLabel(label);
  const candidates = [
    countyName,
    stripAreaSuffix(countyName),
    cityName,
    stripAreaSuffix(cityName),
  ].filter(Boolean);
  return [...new Set(candidates)];
}

function settlementProvinceCodeFromCounty(countyCode?: string) {
  return countyCode && countyCode.length >= 2 ? countyCode.slice(0, 2) : "";
}

function settlementCityNameFromAreaLabel(label: string) {
  const countyName = countyNameFromAreaLabel(label);
  if (countyName.endsWith("市")) return countyName;
  return cityNameFromAreaLabel(label);
}

function lakalaMerchantRegionFromAreaLabel(label: string) {
  // 来自拉卡拉“地区信息”Excel：1754472530400221.xlsx。
  // 江西省=4200，南昌市=4210，红谷滩区未单列，南昌市兜底区县=984210。
  if (label.includes("江西省") && label.includes("南昌市")) {
    const countyByName: Record<string, string> = {
      南昌县: "4211",
      新建县: "4212",
      安义县: "4213",
      进贤县: "4214",
      青山湖区: "4215",
      东湖区: "4216",
      西湖区: "4217",
      青云谱区: "4218",
      湾里区: "4219",
      赣江新区: "4391",
    };
    const countyCode = Object.entries(countyByName).find(([name]) => label.includes(name))?.[1] || "984210";
    return { provinceCode: "4200", cityCode: "4210", countyCode };
  }
  return null;
}

function removeAreaPrefixForLakalaAddress(address: string, areaLabel: string) {
  let result = (address || "").trim();
  if (!result) return result;
  if (!areaLabel) return result;

  const parts = [
    provinceNameFromAreaLabel(areaLabel),
    cityNameFromAreaLabel(areaLabel),
  ].filter(Boolean);

  const countyName = areaLabel
    .replace(provinceNameFromAreaLabel(areaLabel), "")
    .replace(cityNameFromAreaLabel(areaLabel), "");
  if (countyName) parts.push(countyName);

  for (const part of parts) {
    if (part && result.startsWith(part)) result = result.slice(part.length).trim();
  }
  return result;
}

function removeKnownAreaPrefixesForLakalaAddress(address: string, countyCode?: string) {
  let result = (address || "").trim();
  const labels = new Set<string>();
  const selectedArea = getAreaPathByCode(countyCode);
  if (selectedArea.label) labels.add(selectedArea.label);
  const ocrAreaCode = areaCodeFromAddress(result);
  const ocrArea = getAreaPathByCode(ocrAreaCode);
  if (ocrArea.label) labels.add(ocrArea.label);

  for (const label of labels) {
    result = removeAreaPrefixForLakalaAddress(result, label);
  }

  return result;
}

function trimRepeatedShopUnitsForLakalaAddress(address: string) {
  const result = address.trim();
  if (result.length <= 29) return result;
  const firstSegment = result.split(/[、，,；;]/)[0]?.trim();
  if (firstSegment && firstSegment.length >= 6) return firstSegment;
  return result;
}

function lakalaMerchantAddressForSubmit(data: OnboardingApplicationInput) {
  const withoutArea = removeKnownAreaPrefixesForLakalaAddress(
    data.merchantData.merRegAddr,
    data.merchantData.merRegDistCode,
  );
  return trimRepeatedShopUnitsForLakalaAddress(withoutArea);
}

function validateTkbsMerchantAddress(data: OnboardingApplicationInput) {
  const merAddr = lakalaMerchantAddressForSubmit(data);
  if (!merAddr) throw new Error("INVALID_PARAMS: 请填写详细地址（不含省市区）");
  if (merAddr.length > 29) {
    throw new Error(`INVALID_PARAMS: 商户详细地址需控制在 29 字以内，请去掉省市区并缩短门牌描述；当前提交值为：${merAddr}`);
  }
  return merAddr;
}

function lakalaBankRegionFromAreaLabel(label: string) {
  // 来自拉卡拉“银行地区信息”Excel：1754472595153726.xlsx。
  if (label.includes("江西省") && label.includes("南昌市")) {
    return { provinceCode: "36", provinceName: "江西省", cityCode: "4210", cityName: "南昌市" };
  }
  return null;
}

function resolveTkbsRegionCodes(data: OnboardingApplicationInput) {
  const bankDistCode = data.settlementData.bankDistCode || data.merchantData.merRegDistCode;
  const bankArea = getAreaPathByCode(bankDistCode);
  const bankCityCode = data.settlementData.bankAreaCode || tkbsBankCityCode(data.settlementData.openningBankCode || data.settlementData.clearingBankCode);
  const area = getAreaPathByCode(data.merchantData.merRegDistCode);
  const merchantRegion = resolveLocalLakalaMerchantRegionByCode(data.merchantData.merRegDistCode) || lakalaMerchantRegionFromAreaLabel(area.label);
  const bankRegion = lakalaBankRegionFromAreaLabel(bankArea.label || area.label);
  const provinceCode = envOrData("LAKALA_ONBOARDING_PROVINCE_CODE", merchantRegion?.provinceCode);
  const cityCode = envOrData("LAKALA_ONBOARDING_CITY_CODE", merchantRegion?.cityCode);
  const countyCode = envOrData("LAKALA_ONBOARDING_COUNTY_CODE", merchantRegion?.countyCode);
  if (!provinceCode || !cityCode || !countyCode) {
    throw new Error("INVALID_PARAMS: 注册地址地区未匹配到拉卡拉地区码，请重新选择注册地址省市区后再提交");
  }
  return {
    provinceCode,
    cityCode,
    countyCode,
    settleProvinceCode: envOrData("LAKALA_ONBOARDING_SETTLE_PROVINCE_CODE", data.settlementData.settleProvinceCode || bankRegion?.provinceCode || settlementProvinceCodeFromCounty(bankDistCode) || provinceCode),
    settleProvinceName: envOrData("LAKALA_ONBOARDING_SETTLE_PROVINCE_NAME", data.settlementData.settleProvinceName || bankRegion?.provinceName || provinceNameFromAreaLabel(bankArea.label || area.label)),
    settleCityCode: envOrData("LAKALA_ONBOARDING_SETTLE_CITY_CODE", bankRegion?.cityCode || bankCityCode || cityCode),
    settleCityName: envOrData("LAKALA_ONBOARDING_SETTLE_CITY_NAME", data.settlementData.settleCityName || bankRegion?.cityName || settlementCityNameFromAreaLabel(bankArea.label || area.label)),
  };
}

function eContractConfig(name: string, fallback = "") {
  return process.env[name] || fallback;
}

function eContractOrderNo(applicationId: string) {
  return `EC${Date.now()}${applicationId.slice(-6)}`.slice(0, 32);
}

function buildEContractContent(data: OnboardingApplicationInput) {
  const now = new Date();
  const subjectName = data.merchantData.merRegName;
  const legalId = data.legalPersonData.larIdcard;
  const contactName = data.contactData.merContactName;
  const contactMobile = data.contactData.merContactMobile;
  const address = data.shopData.shopAddr || data.merchantData.merRegAddr;
  const businessName = data.merchantData.merBizName || subjectName;
  const fee = "0.38%";
  const unused = "/";
  return {
    A1: subjectName,
    A34: fee,
    A35: fee,
    A36: unused,
    A37: unused,
    A38: unused,
    A63: "是",
    A64: fee,
    A65: "是",
    A66: fee,
    A109: unused,
    A110: unused,
    A111: unused,
    A112: unused,
    A113: unused,
    A114: unused,
    A115: unused,
    A116: "自动结算",
    A117: "是",
    A118: unused,
    A119: unused,
    A120: "是",
    A121: data.merchantData.merRegDistCode,
    // 按凤御门店入网规则，接入平台法律主体随当前营业执照主体自动带入。
    A122: subjectName,
    A123: eContractConfig("LAKALA_ECONTRACT_PLATFORM_NAME", "凤御美业"),
    A124: now.getFullYear(), A125: now.getMonth() + 1, A126: now.getDate(),
    B1: now.getFullYear(), B2: now.getMonth() + 1, B3: "是",
    B8: subjectName,
    B9: getMerchantBusinessContent(),
    B10: businessName,
    B13: address,
    B14: data.merchantData.merBlis,
    B16: data.settlementData.acctName === subjectName ? "是" : unused,
    B17: data.settlementData.acctName === subjectName ? unused : "是",
    B18: data.settlementData.acctName === subjectName ? unused : data.settlementData.acctName,
    B19: resolveOpeningBankName(data.settlementData),
    B20: data.settlementData.acctNo,
    B21: eContractConfig("LAKALA_ECONTRACT_STATEMENT_EMAIL"),
    B24: data.legalPersonData.larName,
    B25: `身份证${legalId}`,
    B26: contactMobile,
    B27: contactName,
    B28: eContractConfig("LAKALA_ECONTRACT_STATEMENT_EMAIL"),
    B29: `身份证${legalId}`,
    B30: contactMobile,
    B31: businessName,
    B32: contactName,
    B33: address,
    B34: contactMobile,
    B35: businessName,
    B36: "1",
    B43: "是",
    B46: "是",
    B50: "是",
    B56: subjectName,
    D1: resolveOpeningBankName(data.settlementData),
    // 按当前门店入网规则，数据处理方信息与营业执照主体、联系人自动保持一致。
    // D8 / D9 留给拉卡拉 H5 电子签约动作完成。
    D6: subjectName,
    D7: contactMobile,
  };
}

function buildEContractReqData(app: NonNullable<Awaited<ReturnType<typeof getOnboardingApplicationForService>>>, data: OnboardingApplicationInput) {
  const callbackUrl = getEContractCallbackUrl();
  if (!callbackUrl) throw new Error("INVALID_STATE: 缺少电子合同回调地址：LAKALA_ECONTRACT_CALLBACK_URL");
  const orderNo = app.eContractOrderNo || eContractOrderNo(app.id);
  return {
    order_no: orderNo,
    org_id: Number(requireOnboardingConfig("LAKALA_ORG_CODE", getEContractOrgId())),
    ec_type_code: getEContractType(),
    cert_type: "RESIDENT_ID",
    cert_name: data.legalPersonData.larName,
    cert_no: data.legalPersonData.larIdcard,
    mobile: data.contactData.merContactMobile,
    business_license_no: data.merchantData.merBlis,
    business_license_name: data.merchantData.merBlisName || data.merchantData.merRegName,
    openning_bank_code: data.settlementData.openningBankCode,
    openning_bank_name: resolveOpeningBankName(data.settlementData),
    acct_type_code: DEFAULT_LAKALA_VALUES.acctTypeCode,
    acct_no: data.settlementData.acctNo,
    acct_name: data.settlementData.acctName,
    ec_content_parameters: JSON.stringify(buildEContractContent(data)),
    agent_tag: 0,
    remark: `凤御门店入网 ${app.orderNo}`,
    ret_url: callbackUrl,
  };
}

function buildAddMerReqData(app: NonNullable<Awaited<ReturnType<typeof getOnboardingApplicationForService>>>, data: OnboardingApplicationInput, fileData: Array<{ type: string; id: string }>) {
  const countyCode = data.merchantData.merRegDistCode;
  const tkbsRegion = resolveTkbsRegionCodes(data);
  const accountIdCard = data.settlementData.accountIdCard || data.legalPersonData.larIdcard;
  const accountIdStart = data.settlementData.accountIdDtStart || data.legalPersonData.larIdcardStDt;
  const accountIdEnd = data.settlementData.accountIdDtEnd || idCardExpiryForSubmit(data.legalPersonData);
  const merAddr = validateTkbsMerchantAddress(data);
  return {
    org_code: requireOnboardingConfig("LAKALA_ORG_CODE", getOrgCode()),
    user_no: requireOnboardingConfig("LAKALA_USER_NO", getOnboardingUserNo()),
    email: data.contactData.email || getOnboardingEmail(),
    busi_code: getOnboardingBusiCode(),
    mer_reg_name: data.merchantData.merRegName,
    mer_type: process.env.LAKALA_ONBOARDING_MER_TYPE || "TP_MERCHANT",
    mer_name: data.merchantData.merBizName || data.merchantData.merRegName,
    mer_addr: merAddr,
    province_code: tkbsRegion.provinceCode,
    city_code: tkbsRegion.cityCode,
    county_code: tkbsRegion.countyCode,
    license_name: data.merchantData.merBlisName || data.merchantData.merRegName,
    license_no: data.merchantData.merBlis,
    license_dt_start: normalizeDateForLakala(data.merchantData.merBlisStDt),
    license_dt_end: normalizeDateForLakala(licenseExpiryForSubmit(data.merchantData)),
    latitude: getOnboardingLatitude(),
    longtude: getOnboardingLongtude(),
    source: getOnboardingSource(),
    business_content: getMerchantBusinessContent(),
    lar_name: data.legalPersonData.larName,
    lar_id_type: DEFAULT_LAKALA_VALUES.larIdType,
    lar_id_card: data.legalPersonData.larIdcard,
    lar_id_card_start: normalizeDateForLakala(data.legalPersonData.larIdcardStDt),
    lar_id_card_end: normalizeDateForLakala(idCardExpiryForSubmit(data.legalPersonData)),
    contact_mobile: data.contactData.merContactMobile,
    contact_name: data.contactData.merContactName,
    openning_bank_code: data.settlementData.openningBankCode,
    openning_bank_name: resolveOpeningBankName(data.settlementData),
    clearing_bank_code: data.settlementData.clearingBankCode || data.settlementData.openningBankCode,
    settle_province_code: tkbsRegion.settleProvinceCode,
    settle_province_name: tkbsRegion.settleProvinceName,
    settle_city_code: tkbsRegion.settleCityCode,
    settle_city_name: tkbsRegion.settleCityName,
    account_no: data.settlementData.acctNo,
    account_name: data.settlementData.acctName,
    account_type: process.env.LAKALA_ONBOARDING_ACCOUNT_TYPE || DEFAULT_LAKALA_VALUES.accountType,
    account_id_type: DEFAULT_LAKALA_VALUES.larIdType,
    account_id_card: accountIdCard,
    account_id_dt_start: normalizeDateForLakala(accountIdStart),
    account_id_dt_end: normalizeDateForLakala(accountIdEnd),
    external_no: app.orderNo,
    contract_no: app.eContractNo || undefined,
    biz_content: {
      term_num: process.env.LAKALA_ONBOARDING_TERM_NUM || "1",
      fees: DEFAULT_FEE_DATA,
      mcc: getOnboardingMcc(),
      activity_id: requireOnboardingConfig("LAKALA_ACTIVITY_ID", getOnboardingActivityId()),
    },
    attchments: fileData,
    settle_type: process.env.LAKALA_ONBOARDING_SETTLE_TYPE || DEFAULT_LAKALA_VALUES.settleType,
    settlement_type: getOnboardingSettlementType(),
  };
}

export const initiateElectronicContract = withPermission(
  "merchant:update",
  async (session, applicationId: string): Promise<{ success: boolean; message: string; resultUrl?: string }> => {
    await ensureOnboardingSchema();
    const app = await getOnboardingApplicationForService(applicationId);
    if (!app) return { success: false, message: "申请不存在" };
    if (app.eContractStatus === "COMPLETED" && app.eContractNo) return { success: true, message: "电子合同已签约完成", resultUrl: app.eContractResultUrl ?? undefined };
    try {
      const data = requiredData(app);
      const reqData = buildEContractReqData(app, data);
      const result = await lakalaApplyElectronicContract(reqData);
      await writeLog({ applicationId, apiName: "mms.ec.apply", requestPayload: reqData, responsePayload: result.raw, success: result.success, errorCode: result.errorCode, errorMessage: result.errorMessage });
      if (!result.success || !result.resultUrl) throw new Error(`INVALID_STATE: ${result.errorMessage || "电子合同申请失败"}`);
      await db.update(lakalaOnboardingApplications).set({
        eContractOrderNo: result.orderNo || reqData.order_no,
        eContractApplyId: result.applyId || null,
        eContractResultUrl: result.resultUrl,
        eContractStatus: "UNDONE",
        lastErrorCode: null,
        lastErrorMessage: null,
      }).where(eq(lakalaOnboardingApplications.id, applicationId));
      await logOperation(session, "merchant.onboarding.econtract.apply", "lakala_onboarding_application", applicationId, { orderNo: reqData.order_no, ecType: reqData.ec_type_code });
      revalidatePath(`/merchants/onboarding-prototype/${applicationId}`);
      return { success: true, message: "电子合同已发起，请完成签约", resultUrl: result.resultUrl };
    } catch (error) {
      // diagnosticText 只落 DB 的 lastErrorMessage 供运维排查（刻意不叫 *message，
      // 与 action-error-usage 护栏「进返回值的 message 必须 fail-closed」口径区分开）。
      // 供应商拒绝原因本身就是用白名单前缀抛的（上面 `INVALID_STATE: ${result.errorMessage}`），
      // 所以照常透传；被挡掉的只有 PG / TypeError 这类内部异常（issue #133 评审 round 3）。
      const diagnosticText = error instanceof Error ? error.message : "电子合同申请失败";
      await db.update(lakalaOnboardingApplications).set({ lastErrorMessage: diagnosticText }).where(eq(lakalaOnboardingApplications.id, applicationId));
      return { success: false, message: businessErrorMessage(error, "电子合同申请失败") };
    }
  },
);

export const submitOnboardingApplication = withPermission(
  "merchant:update",
  async (session, applicationId: string): Promise<{ success: boolean; message: string }> => {
    await ensureOnboardingSchema();
    const app = await getOnboardingApplicationForService(applicationId);
    if (!app) return { success: false, message: "申请不存在" };
    if (app.lakalaMerchantId) {
      return { success: true, message: "该申请已生成收款商户，无需重复提交" };
    }
    if (app.merInnerNo || app.merCupNo) {
      return { success: false, message: app.status === "FAILED" ? "该申请已被拉卡拉拒绝，请保存修正资料后重新提交" : "该申请已提交拉卡拉，请查询审核状态，不可重复新增" };
    }
    if (app.status === "SUBMITTED" || app.status === "SUCCESS" || app.status === "REGISTERING") {
      return { success: true, message: "该申请已提交拉卡拉，请直接查询状态" };
    }
    if (app.eContractStatus !== "COMPLETED" || !app.eContractNo) {
      return { success: false, message: "请先完成拉卡拉电子合同签约" };
    }
    await db.update(lakalaOnboardingApplications).set({ status: "SUBMITTING", lastErrorCode: null, lastErrorMessage: null }).where(eq(lakalaOnboardingApplications.id, applicationId));
    try {
      const data = requiredData(app);
      const isRealTkbs = getLakalaOnboardingClientMode() === "real" && getLakalaOnboardingApiFamily() === "tkbs";
      if (isRealTkbs) verifyOnboardingSm4Key();
      const fileData = await validateAndUploadAttachments(app);
      const reqData = buildAddMerReqData(app, data, fileData);
      const result = await lakalaAddMerchant(reqData);
      await writeLog({ applicationId, apiName: isRealTkbs ? "tkbs.merchant_encry" : "addMer", requestPayload: reqData, responsePayload: result.raw, success: result.success, errorCode: result.errorCode, errorMessage: result.errorMessage });
      if (!result.success) throw new Error(`INVALID_STATE: ${result.errorMessage || "拉卡拉进件失败"}`);
      if (isRealTkbs) {
        await db.update(lakalaOnboardingApplications).set({
          status: "REGISTERING",
          lakalaRequestData: maskPayload(reqData),
          contractId: result.contractId,
          merInnerNo: result.merInnerNo,
          merCupNo: result.merCupNo,
          submittedAt: new Date(),
        }).where(eq(lakalaOnboardingApplications.id, applicationId));
        await logOperation(session, "merchant.onboarding.submit", "lakala_onboarding_application", applicationId, { merInnerNo: result.merInnerNo, merCupNo: result.merCupNo });
        revalidatePath("/merchants");
        revalidatePath(`/merchants/onboarding-prototype/${applicationId}`);
        return { success: true, message: "已提交拉卡拉，等待审核；审核通过后再绑定收款商户" };
      }
      const merchantId = ksuid("lm_");
      const merchantName = data.merchantData.merRegName || data.merchantData.merBlisName || data.merchantData.merBizName || app.orderNo;
      const [marketRow] = await db.select({ marketId: orgNodes.parentId }).from(stores).innerJoin(orgNodes, eq(stores.orgNodeId, orgNodes.id)).where(eq(stores.storeId, app.storeId)).limit(1);
      await db.insert(lakalaMerchants).values({
        id: merchantId,
        merchantName,
        merchantNo: result.merCupNo || result.merInnerNo || null,
        termNo: null,
        enabled: true,
        marketOrgNodeId: marketRow?.marketId ?? null,
      });
      await db.update(stores).set({ lakalaMerchantId: merchantId }).where(eq(stores.storeId, app.storeId));
      await db.update(lakalaOnboardingApplications).set({
        status: "SUBMITTED",
        lakalaRequestData: maskPayload(reqData),
        contractId: result.contractId,
        merInnerNo: result.merInnerNo,
        merCupNo: result.merCupNo,
        lakalaMerchantId: merchantId,
        submittedAt: new Date(),
      }).where(eq(lakalaOnboardingApplications.id, applicationId));
      await logOperation(session, "merchant.onboarding.submit", "lakala_onboarding_application", applicationId, { merchantId });
      revalidatePath("/merchants");
      revalidatePath(`/merchants/onboarding-prototype/${applicationId}`);
      return { success: true, message: "已提交拉卡拉，收款商户已生成并绑定门店" };
    } catch (error) {
      // 同上：DB 留原始文本供运维，前端只拿 fail-closed 后的文案
      const diagnosticText = error instanceof Error ? error.message : "提交失败";
      const nextStatus = app.merInnerNo || app.merCupNo ? "FAILED" : "FILES_READY";
      await db.update(lakalaOnboardingApplications).set({ status: nextStatus, lastErrorMessage: diagnosticText }).where(eq(lakalaOnboardingApplications.id, applicationId));
      return { success: false, message: businessErrorMessage(error, "提交失败") };
    }
  },
);

export const searchOnboardingBanks = withPermission(
  "merchant:update",
  async (_session, applicationId: string, bankName: string, bankDistCode?: string): Promise<{ success: boolean; message: string; areaCode?: string; banks: OnboardingBankOption[] }> => {
    await ensureOnboardingSchema();
    const app = await getOnboardingApplicationForService(applicationId);
    if (!app) return { success: false, message: "申请不存在", banks: [] };
    const keyword = bankName.trim();
    if (keyword.length < 2) return { success: false, message: "请输入至少两个字的银行名称，例如：中国工商银行", banks: [] };

    const data = mergeInput({
      merchantData: app.merchantData as JsonRecord,
      legalPersonData: app.legalPersonData as JsonRecord,
      contactData: app.contactData as JsonRecord,
      settlementData: app.settlementData as JsonRecord,
      shopData: app.shopData as JsonRecord,
      terminalData: app.terminalData as JsonRecord,
    });
    const selectedBankDistCode = bankDistCode || data.settlementData.bankDistCode || data.merchantData.merRegDistCode;
    const bankArea = getAreaPathByCode(selectedBankDistCode);
    if (!bankArea.countyCode) return { success: false, message: "请先选择开户行所在地", banks: [] };

    const areaKeywords = areaKeywordsFromAreaLabel(bankArea.label);
    const localBanks = await queryLocalLakalaBanksByAreaKeywords({ areaKeywords, bankName: keyword });
    if (localBanks.length) {
      return {
        success: true,
        message: `已从本地拉卡拉银行字典找到 ${localBanks.length} 个匹配支行`,
        areaCode: localBanks[0]?.areaCode,
        banks: localBanks,
      };
    }

    const inferredAreaCodes = await findLocalLakalaBankAreaCodes({ areaKeywords });
    const areaCode = data.settlementData.bankAreaCode || inferredAreaCodes[0] || resolveTkbsRegionCodes({
      ...data,
      settlementData: { ...data.settlementData, bankDistCode: selectedBankDistCode },
    }).settleCityCode;
    const result = await lakalaQueryBanks({ areaCode, bankName: keyword });
    if (!result.success) return { success: false, message: result.errorMessage || "拉卡拉银行列表查询失败", areaCode, banks: [] };
    return {
      success: true,
      message: result.banks.length ? `本地未找到，已在线查询拉卡拉并找到 ${result.banks.length} 个匹配支行` : "未找到匹配支行，请调整银行名称或确认开户行所在地",
      areaCode,
      banks: result.banks,
    };
  },
);

export const reconsiderOnboardingApplication = withPermission(
  "merchant:update",
  async (session, applicationId: string): Promise<{ success: boolean; message: string }> => {
    await ensureOnboardingSchema();
    const app = await getOnboardingApplicationForService(applicationId);
    if (!app) return { success: false, message: "申请不存在" };
    if (app.status !== "FAILED") return { success: false, message: "仅审核拒绝的申请可以修正后重新提交" };
    const data = requiredData(app);
    const isRealTkbs = getLakalaOnboardingClientMode() === "real" && getLakalaOnboardingApiFamily() === "tkbs";
    if (isRealTkbs) verifyOnboardingSm4Key();

    // 审核拒绝后，拉卡拉确认应修正资料后重新走 merchant_encry 正式提交。
    // 不再额外调用 open_merchant_reconsider_submit，否则会在 WAIT_AUDI 后返回系统异常。
    const fileData = await validateAndUploadAttachments(app);
    const reqData = buildAddMerReqData(app, data, fileData);
    const syncResult = await lakalaAddMerchant(reqData);
    await writeLog({
      applicationId,
      apiName: isRealTkbs ? "tkbs.merchant_encry.reconsider_prepare" : "addMer.reconsider_prepare",
      requestPayload: reqData,
      responsePayload: syncResult.raw,
      success: syncResult.success,
      errorCode: syncResult.errorCode,
      errorMessage: syncResult.errorMessage,
    });
    if (!syncResult.success) {
      const message = syncResult.errorMessage || "重新提交前同步修正资料失败";
      await db.update(lakalaOnboardingApplications).set({ lastErrorCode: syncResult.errorCode || null, lastErrorMessage: message }).where(eq(lakalaOnboardingApplications.id, applicationId));
      return { success: false, message };
    }

    await db.update(lakalaOnboardingApplications).set({
      status: "REGISTERING",
      lakalaRequestData: maskPayload(reqData),
      merInnerNo: syncResult.merInnerNo || app.merInnerNo,
      merCupNo: syncResult.merCupNo || app.merCupNo,
      lastErrorCode: null,
      lastErrorMessage: null,
      submittedAt: new Date(),
    }).where(eq(lakalaOnboardingApplications.id, applicationId));
    await logOperation(session, "merchant.onboarding.resubmit", "lakala_onboarding_application", applicationId, { customerNo: syncResult.merInnerNo || app.merInnerNo || app.merCupNo });
    revalidatePath(`/merchants/onboarding-prototype/${applicationId}`);
    revalidatePath("/merchants");
    return { success: true, message: "已重新提交资料，请稍后查询审核结果" };
  },
);

export const queryOnboardingApplication = withPermission(
  "merchant:list",
  async (_session, applicationId: string): Promise<{ success: boolean; message: string }> => {
    await ensureOnboardingSchema();
    const app = await getOnboardingApplicationForService(applicationId);
    if (!app) return { success: false, message: "申请不存在" };
    const result = await lakalaQuerySubMerchant({ contractId: app.contractId, merInnerNo: app.merInnerNo, merCupNo: app.merCupNo });
    const isTkbs = getLakalaOnboardingApiFamily() === "tkbs";
    await writeLog({
      applicationId,
      apiName: isTkbs ? "tkbs.open_merchant_info" : "querySubMerInfo",
      requestPayload: isTkbs
        ? { merchant_no: null, customer_no: app.merInnerNo || app.merCupNo, org_code: getOrgCode() }
        : { contractId: app.contractId, merInnerNo: app.merInnerNo, merCupNo: app.merCupNo },
      responsePayload: result.raw,
      success: result.success,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    });
    const customer = result.raw.resp_data && typeof result.raw.resp_data === "object"
      ? (result.raw.resp_data as Record<string, unknown>).customer as Record<string, unknown> | undefined
      : undefined;
    const externalMerchantNo = result.merchantNo || (customer && typeof customer.merchant_no === "string" ? customer.merchant_no : undefined);
    const terminalNo = result.terminalNo;
    const nextStatus = result.status === "SUCCESS" ? "SUCCESS" : result.status === "FAILED" ? "FAILED" : "REGISTERING";
    const nextTerminalData = terminalNo
      ? { ...((app.terminalData as Record<string, unknown>) ?? {}), termNo: terminalNo }
      : app.terminalData;
    await db.update(lakalaOnboardingApplications).set({
      status: nextStatus,
      ...(externalMerchantNo ? { merCupNo: externalMerchantNo } : {}),
      ...(terminalNo ? { terminalData: nextTerminalData } : {}),
      lastErrorCode: result.errorCode,
      lastErrorMessage: result.errorMessage,
    }).where(eq(lakalaOnboardingApplications.id, applicationId));
    revalidatePath(`/merchants/onboarding-prototype/${applicationId}`);
    revalidatePath("/merchants");
    return { success: true, message: `状态已更新：${statusLabel(result.status)}` };
  },
);

export const refreshOnboardingSubMerchants = withPermission(
  "merchant:list",
  async (_session, applicationId: string): Promise<{ success: boolean; message: string }> => {
    await ensureOnboardingSchema();
    const app = await getOnboardingApplicationForService(applicationId);
    if (!app) return { success: false, message: "申请不存在" };
    if (app.status !== "SUCCESS" || !app.merCupNo?.startsWith("82")) return { success: false, message: "请先等待拉卡拉审核通过并取得银联商户号" };
    const result = await refreshChannelSubMerchantsForApplication(applicationId, app.merCupNo);
    if (!result.success) {
      // 失败也已写库 subMerchantCheckedAt/lastError，须刷新页面让"上次查询"与错误提示可见
      revalidatePath(`/merchants/onboarding-prototype/${applicationId}`);
      return { success: false, message: result.errorMessage || "子商户号查询失败" };
    }
    revalidatePath(`/merchants/onboarding-prototype/${applicationId}`);
    const messages = [
      result.wechat.length ? `微信子商户号：${result.wechat.map((item) => item.subMerchantNo).join("、")}` : "微信子商户号暂未返回",
      result.alipay.length ? `支付宝子商户号：${result.alipay.map((item) => item.subMerchantNo).join("、")}` : "支付宝子商户号暂未返回",
    ];
    return {
      success: true,
      message: result.wechat.length && result.alipay.length
        ? `${messages.join("；")}。请法人按指南完成微信/支付宝认证，完成后点击“我已完成认证，关联收款商户”`
        : `${messages.join("；")}。请稍后点击“查询子商户号”手动重试`,
    };
  },
);

export const confirmOnboardingExternalCertification = withPermission(
  "merchant:update",
  async (session, applicationId: string): Promise<{ success: boolean; message: string }> => {
    await ensureOnboardingSchema();
    const app = await getOnboardingApplicationForService(applicationId);
    if (!app) return { success: false, message: "申请不存在" };
    if (app.status !== "SUCCESS") return { success: false, message: "请先等待拉卡拉入网审核通过" };

    const channelData = (app.channelData as Record<string, unknown>) ?? {};
    const terminalNo = getStoredTerminalNo(app.terminalData);
    const missing = [
      !app.merCupNo?.startsWith("82") ? "银联商户号" : null,
      !terminalNo ? "终端号" : null,
      !hasWechatSubMerchant(channelData) ? "微信子商户号" : null,
      !hasAlipaySubMerchant(channelData) ? "支付宝子商户号" : null,
    ].filter((item): item is string => Boolean(item));
    if (missing.length) return { success: false, message: `请先取得：${missing.join("、")}` };

    const now = new Date().toISOString();
    const outcome = await db.transaction(async (tx) => {
      const result = await associateDisabledMerchantForApplication(tx, app);
      if ("error" in result) return result;
      await tx.update(lakalaOnboardingApplications).set({
        lakalaMerchantId: result.merchantId,
        channelData: {
          ...channelData,
          externalCertificationConfirmedAt: now,
          externalCertificationConfirmedBy: session.name || session.phone || session.employeeId,
        },
        lastErrorCode: null,
        lastErrorMessage: null,
      }).where(eq(lakalaOnboardingApplications.id, applicationId));
      return result;
    });
    if ("error" in outcome) {
      revalidatePath(`/merchants/onboarding-prototype/${applicationId}`);
      revalidatePath("/merchants");
      return { success: false, message: outcome.error };
    }
    const merchantId = outcome.merchantId;
    await logOperation(session, "merchant.onboarding.external_certification.confirm", "lakala_onboarding_application", applicationId, {
      merchantId,
      merCupNo: app.merCupNo,
      terminalNo,
    });
    revalidatePath(`/merchants/onboarding-prototype/${applicationId}`);
    revalidatePath("/merchants");
    return { success: true, message: "已关联收款商户，状态为未启用；请到“收款商户”页手动启用" };
  },
);


export const testOnboardingWechatAuthState = withPermission(
  "merchant:list",
  async (_session, applicationId: string): Promise<{
    success: boolean;
    message: string;
    requestPayload?: Record<string, unknown>;
    result?: MerchantAuthStateResult;
  }> => {
    await ensureOnboardingSchema();
    const app = await getOnboardingApplicationForService(applicationId);
    if (!app) return { success: false, message: "申请不存在" };
    const current = (app.channelData as Record<string, unknown>) ?? {};
    const wechatSubMerchantNo = getChannelItems(current, "wechat")[0]?.subMerchantNo;
    if (!app.merCupNo?.startsWith("82") || !wechatSubMerchantNo) {
      return { success: false, message: "缺少银联商户号或微信子商户号，无法测试开户状态查询" };
    }
    const requestPayload = {
      merchantNo: app.merCupNo,
      tradeMode: "WECHAT",
      subMerchantId: wechatSubMerchantNo,
    } as const;
    const result = await lakalaQueryMerchantAuthState(requestPayload);
    await writeLog({
      applicationId,
      apiName: "mms.sme.mrchAuthStateQuery.WECHAT",
      requestPayload,
      responsePayload: result.raw,
      success: result.success,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    });
    const nextChannelData = {
      ...current,
      wechatAuthStateQuery: {
        requestPayload,
        success: result.success,
        checkResult: result.checkResult,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        checkedAt: new Date().toISOString(),
        raw: result.raw,
      },
    };
    await db.update(lakalaOnboardingApplications).set({
      channelData: nextChannelData,
      lastErrorMessage: result.success ? null : (result.errorMessage || "微信开户状态查询失败"),
    }).where(eq(lakalaOnboardingApplications.id, applicationId));
    revalidatePath(`/merchants/onboarding-prototype/${applicationId}`);
    return {
      success: result.success,
      message: result.success
        ? `微信开户状态查询成功：${result.checkResult || "未返回 checkResult"}`
        : `微信开户状态查询失败：${result.errorMessage || result.errorCode || "未知错误"}`,
      requestPayload,
      result,
    };
  },
);
