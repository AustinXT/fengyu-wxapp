export const ATTACHMENT_REQUIREMENTS = [
  { key: "businessLicense", label: "营业执照", attType: "BUSINESS_LICENCE", displayName: "营业执照" },
  { key: "legalIdFront", label: "法人身份证正面", attType: "ID_CARD_FRONT", displayName: "法人身份证正面" },
  { key: "legalIdBack", label: "法人身份证反面", attType: "ID_CARD_BEHIND", displayName: "法人身份证反面" },
  { key: "openingPermit", label: "开户许可证", attType: "OPENING_PERMIT", displayName: "开户许可证" },
  { key: "storeFront", label: "门头照", attType: "SHOP_OUTSIDE_IMG", displayName: "门头照" },
  { key: "storeInterior", label: "店铺内景照", attType: "SHOP_INSIDE_IMG", displayName: "店铺内景照" },
  { key: "cashierPhoto", label: "店铺收银照", attType: "CHECKSTAND_IMG", displayName: "店铺收银照" },
] as const;

export const AGREEMENT_ATTACHMENT = {
  key: "agreement",
  label: "电子协议",
  attType: "AGREE_MENT",
  displayName: "电子协议",
} as const;

export const MAX_ONBOARDING_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export const DEFAULT_FEE_DATA = [
  { fee_code: "WECHAT", fee_value: "0.38" },
  { fee_code: "ALIPAY", fee_value: "0.38" },
  { fee_code: "SCAN_PAY", fee_value: "0.38" },
] as const;

export const DEFAULT_LAKALA_VALUES = {
  version: "1.0",
  tkbsVersion: "1.0",
  posType: "WECHAT_PAY",
  acctTypeCode: "57",
  accountType: "57",
  settlePeriod: "D+1",
  settleType: "D1",
  settlementType: "AUTOMATIC",
  // 拓客商服 API 的 "获取小类" 返回码，不是旧行业分类里的 7230。
  mccCode: "13002",
  larIdType: "01",
  clearDt: "TWENTY_THREE",
  source: "H5",
} as const;

export function normalizeTkbsAttachmentType(attType: string, displayName?: string) {
  if (displayName === "营业执照") return "BUSINESS_LICENCE";
  if (displayName === "法人身份证正面") return "ID_CARD_FRONT";
  if (displayName === "法人身份证反面") return "ID_CARD_BEHIND";
  if (displayName === "开户许可证") return "OPENING_PERMIT";
  if (displayName === "门头照") return "SHOP_OUTSIDE_IMG";
  if (displayName === "店铺内景照") return "SHOP_INSIDE_IMG";
  if (displayName === "店铺收银照") return "CHECKSTAND_IMG";
  if (displayName === "电子协议") return "AGREE_MENT";

  const legacyMap: Record<string, string> = {
    BUSINESS_LICENSE: "BUSINESS_LICENCE",
    FR_ID_CARD_FRONT: "ID_CARD_FRONT",
    FR_ID_CARD_BEHIND: "ID_CARD_BEHIND",
    ID_CARD_BACK: "ID_CARD_BEHIND",
    MERCHANT_PHOTO: "SHOP_OUTSIDE_IMG",
    SHOPINNER: "SHOP_INSIDE_IMG",
    SHOP_INNER: "SHOP_INSIDE_IMG",
    CASHIER_PHOTO: "CHECKSTAND_IMG",
    NETWORK_XY: "AGREE_MENT",
  };
  return legacyMap[attType] || attType;
}
