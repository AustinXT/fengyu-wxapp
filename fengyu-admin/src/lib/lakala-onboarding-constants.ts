/**
 * 拉卡拉入网资料的固定约束。
 *
 * 这里的附件类型同时是数据库中 attachment_type 的稳定值；不要把浏览器传来的
 * 任意字符串直接用于拉卡拉请求。
 */
export const ATTACHMENT_REQUIREMENTS = [
  { key: 'businessLicense', label: '营业执照', attachmentType: 'BUSINESS_LICENCE', displayName: '营业执照' },
  { key: 'legalIdFront', label: '法人身份证正面', attachmentType: 'ID_CARD_FRONT', displayName: '法人身份证正面' },
  { key: 'legalIdBack', label: '法人身份证反面', attachmentType: 'ID_CARD_BEHIND', displayName: '法人身份证反面' },
  { key: 'openingPermit', label: '开户许可证', attachmentType: 'OPENING_PERMIT', displayName: '开户许可证' },
  { key: 'storeFront', label: '门头照', attachmentType: 'SHOP_OUTSIDE_IMG', displayName: '门头照' },
  { key: 'storeInterior', label: '店铺内景照', attachmentType: 'SHOP_INSIDE_IMG', displayName: '店铺内景照' },
  { key: 'cashierPhoto', label: '店铺收银照', attachmentType: 'CHECKSTAND_IMG', displayName: '店铺收银照' },
] as const

/** 拉卡拉下载后的已签约合同，仅保存在私有附件存储中。 */
export const ELECTRONIC_CONTRACT_PDF_ATTACHMENT = {
  key: 'electronicContractPdf',
  label: '已签约电子合同',
  attachmentType: 'E_CONTRACT_PDF',
  displayName: '已签约电子合同.pdf',
} as const

export const MAX_ONBOARDING_ATTACHMENT_BYTES = 5 * 1024 * 1024

export const ALLOWED_ONBOARDING_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'application/pdf',
])

export const ALLOWED_ONBOARDING_FILE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'pdf',
])

export const DEFAULT_LAKALA_VALUES = {
  tkbsVersion: '1.0',
  accountType: '57',
  larIdType: '01',
  settleType: 'D1',
  settlementType: 'AUTOMATIC',
  source: 'H5',
} as const

/** 将交接资料中的历史命名统一成拉卡拉当前进件接口使用的类型。 */
export function normalizeTkbsAttachmentType(attachmentType: string, displayName?: string): string {
  const byDisplayName: Record<string, string> = {
    '营业执照': 'BUSINESS_LICENCE',
    '法人身份证正面': 'ID_CARD_FRONT',
    '法人身份证反面': 'ID_CARD_BEHIND',
    '开户许可证': 'OPENING_PERMIT',
    '门头照': 'SHOP_OUTSIDE_IMG',
    '店铺内景照': 'SHOP_INSIDE_IMG',
    '店铺收银照': 'CHECKSTAND_IMG',
  }
  if (displayName && byDisplayName[displayName]) return byDisplayName[displayName]

  const legacyMap: Record<string, string> = {
    BUSINESS_LICENSE: 'BUSINESS_LICENCE',
    FR_ID_CARD_FRONT: 'ID_CARD_FRONT',
    FR_ID_CARD_BEHIND: 'ID_CARD_BEHIND',
    ID_CARD_BACK: 'ID_CARD_BEHIND',
    MERCHANT_PHOTO: 'SHOP_OUTSIDE_IMG',
    SHOPINNER: 'SHOP_INSIDE_IMG',
    SHOP_INNER: 'SHOP_INSIDE_IMG',
    CASHIER_PHOTO: 'CHECKSTAND_IMG',
  }
  return legacyMap[attachmentType] ?? attachmentType
}
