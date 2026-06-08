import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core'
import { adminPasswords } from './admin-auth'
import {
  lakalaAttachmentTypeEnum,
  lakalaContractStatusEnum,
  lakalaLogDirectionEnum,
  lakalaOnboardingStatusEnum,
  lakalaRealnameStatusEnum,
} from './enums'

/**
 * 拉卡拉商户入网主表（聚合根）
 *
 * 对应 plan §1.1。一个 lakala_merchants 行串起：
 *   - 14 步入网流程状态机（onboarding_status / contract_status / wx_realname_status / alipay_realname_status）
 *   - 拉卡拉端核心交付物（merchant_no / term_no / wx_sub_mchid / alipay_sub_mchid）
 *   - 表单 form_data（jsonb）+ 复议 diff 基线 last_submitted_form_data
 *   - reqId 幂等复用 last_req_ids（按 endpoint 索引）
 *
 * **费率字段不入主表**（plan §0★）：避免 UI 渲染意外暴露。费率统一存 system_configs.lakala.rate.*。
 * **out_org_code 加 unique**（plan §1.1）：回调匹配 + 复议幂等。
 * **contract_no 不加 unique**（plan §1.1）：拉卡拉端天然全局唯一，DB 层 unique 会阻塞合同申请重试。
 */
export const lakalaMerchants = pgTable(
  'lakala_merchants',
  {
    id: text('id').primaryKey(),
    /** 入网申请人（legacy 迁入行可为 NULL）；引用 admin_passwords.id */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    applicantUserId: integer('applicant_user_id').references((): any => adminPasswords.id),
    merchantName: text('merchant_name').notNull(),
    /** 进件流水号；createDraft 时生成（lm-{ksuid}），用于回调匹配 + 复议幂等 */
    outOrgCode: text('out_org_code').notNull().unique(),
    /** 电子合同号（不加 unique，避免阻塞合同申请重试） */
    contractNo: text('contract_no'),
    /** submitMerchant 时快照，appeal 时计算 diff */
    lastSubmittedFormData: jsonb('last_submitted_form_data'),
    /** 按 endpoint 存上次未确认成功的 reqId，重试时复用保证拉卡拉端幂等 */
    lastReqIds: jsonb('last_req_ids').notNull().default({}),
    contractStatus: lakalaContractStatusEnum('contract_status').notNull().default('draft'),
    /** 合同下载后存到 CloudBase 的 URL */
    contractPdfUrl: text('contract_pdf_url'),
    /** 拉卡拉商户号（核心交付物 1，回调拿到才回填） */
    merchantNo: text('merchant_no'),
    /** 终端号（核心交付物 2） */
    termNo: text('term_no'),
    /** 微信子商户号 */
    wxSubMchid: text('wx_sub_mchid'),
    /** 微信子 AppId */
    wxSubAppid: text('wx_sub_appid'),
    /** 支付宝子商户号 */
    alipaySubMchid: text('alipay_sub_mchid'),
    wxRealnameStatus: lakalaRealnameStatusEnum('wx_realname_status').notNull().default('not_submitted'),
    /** 微信实名法人扫码授权 url（拉卡拉返回 qrcodeData base64，前端直接渲染） */
    wxRealnameQrcodeUrl: text('wx_realname_qrcode_url'),
    alipayRealnameStatus: lakalaRealnameStatusEnum('alipay_realname_status').notNull().default('not_submitted'),
    alipayRealnameQrcodeUrl: text('alipay_realname_qrcode_url'),
    /** 14 步流程汇总状态机 */
    onboardingStatus: lakalaOnboardingStatusEnum('onboarding_status').notNull().default('draft'),
    lastErrorCode: text('last_error_code'),
    lastErrorMsg: text('last_error_msg'),
    lastCallbackAt: timestamp('last_callback_at'),
    lastQueryAt: timestamp('last_query_at'),
    /** 草稿态完整表单（基本/法人/经营/结算/附件/实名报备） */
    formData: jsonb('form_data'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    index('idx_lakala_merchants_onboarding_status').on(table.onboardingStatus),
    index('idx_lakala_merchants_merchant_no').on(table.merchantNo),
    index('idx_lakala_merchants_applicant_user_id').on(table.applicantUserId),
  ],
)

/**
 * 拉卡拉商户附件（plan §1.2）
 *
 * 上传链路：admin /api/upload → reuploadToFixedPath 重命名到 lakala/{merchantId}/{type}-{n}.{ext}
 *           → 调拉卡拉 uploadFile → 回填 attchId。
 * 进件接口的 fileData[].attFileId 即取自此表 attchId。
 */
export const lakalaMerchantAttachments = pgTable(
  'lakala_merchant_attachments',
  {
    id: text('id').primaryKey(),
    lakalaMerchantId: text('lakala_merchant_id')
      .notNull()
      .references(() => lakalaMerchants.id, { onDelete: 'cascade' }),
    attachmentType: lakalaAttachmentTypeEnum('attachment_type').notNull(),
    /** CloudBase 上 PDF/图片的访问 URL（admin UI 渲染用） */
    localUrl: text('local_url').notNull(),
    /** CloudBase 内部固定路径（lakala/{id}/{type}-{n}.{ext}），便于 deleteByCloudPaths */
    cloudPath: text('cloud_path').notNull(),
    /** 拉卡拉返回的附件 ID（uploadFile.respData.attFileId）；上传到拉卡拉前为 NULL */
    attchId: text('attch_id'),
    uploadedToLakalaAt: timestamp('uploaded_to_lakala_at'),
    /** 文件元数据：mimeType / sizeBytes / originalName 等 */
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    index('idx_lakala_attachments_merchant').on(table.lakalaMerchantId),
    /** 同一商户、同一附件类型、同一拉卡拉 attchId 至多一条（防重复上传同一拉卡拉文件） */
    unique('uq_lakala_attachments_dedupe').on(
      table.lakalaMerchantId,
      table.attachmentType,
      table.attchId,
    ),
  ],
)

/**
 * 拉卡拉 API 调用流水 + 回调审计（plan §1.3）
 *
 * direction:
 *   outbound          — admin 调拉卡拉接口
 *   inbound_callback  — 拉卡拉回调 admin /api/lakala/callback/*
 *
 * **写入前强制脱敏**：所有 INSERT 必经 fengyu-admin/src/lib/lakala-redact.ts 的 redact()，
 * PII（idCard/bankCard/phone/legalCertNo 等）+ 费率（feeRate/rateCode 等）一律 mask。
 * 见 [user_privacy] + plan §0★。
 */
export const lakalaMerchantLogs = pgTable(
  'lakala_merchant_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    lakalaMerchantId: text('lakala_merchant_id')
      .notNull()
      .references(() => lakalaMerchants.id, { onDelete: 'cascade' }),
    direction: lakalaLogDirectionEnum('direction').notNull(),
    /** 拉卡拉 API path（如 /api/v2/mms/openApi/addMer）或回调路由名 */
    endpoint: text('endpoint').notNull(),
    /** 请求 body（已 redact） */
    reqBody: jsonb('req_body'),
    /** 响应 body（已 redact） */
    respBody: jsonb('resp_body'),
    /** 拉卡拉响应 code（000000 = 成功 / BBS00000 = labs 域成功） */
    respCode: text('resp_code'),
    /** 端到端耗时（ms） */
    latencyMs: integer('latency_ms'),
    /** 操作人；系统回调可为 null */
    operatorUserId: integer('operator_user_id').references(() => adminPasswords.id),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_lakala_logs_merchant_time').on(table.lakalaMerchantId, table.createdAt),
  ],
)

export type LakalaMerchant = typeof lakalaMerchants.$inferSelect
export type NewLakalaMerchant = typeof lakalaMerchants.$inferInsert
export type LakalaMerchantAttachment = typeof lakalaMerchantAttachments.$inferSelect
export type NewLakalaMerchantAttachment = typeof lakalaMerchantAttachments.$inferInsert
export type LakalaMerchantLog = typeof lakalaMerchantLogs.$inferSelect
export type NewLakalaMerchantLog = typeof lakalaMerchantLogs.$inferInsert
