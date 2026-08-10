import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { lakalaMerchants } from './lakala'
import { stores } from './org'

/**
 * 入网申请状态机。终态申请不占用门店的活跃申请名额；是否允许重新发起由应用层
 * 根据门店当前的收款商户绑定状态决定。
 */
export const lakalaOnboardingStatuses = [
  'DRAFT',
  'FILES_UPLOADING',
  'FILES_READY',
  'SUBMITTING',
  'SUBMITTED',
  'REGISTERING',
  'SUCCESS',
  'FAILED',
  'CANCELLED',
] as const

export type LakalaOnboardingStatus = (typeof lakalaOnboardingStatuses)[number]

export const lakalaOnboardingAttachmentStatuses = [
  'LOCAL_SAVED',
  'UPLOADING',
  'UPLOADED',
  'EXPIRED',
  'FAILED',
  'DELETED',
] as const

export type LakalaOnboardingAttachmentStatus = (typeof lakalaOnboardingAttachmentStatuses)[number]

export const lakalaOnboardingRequestLogStatuses = ['PENDING', 'SUCCEEDED', 'FAILED'] as const

export type LakalaOnboardingRequestLogStatus = (typeof lakalaOnboardingRequestLogStatuses)[number]

/**
 * 拉卡拉门店入网申请。敏感业务资料按域拆分为 JSONB，仅允许经门店范围校验的
 * 服务端代码读取。电子合同签约链接只可由发起动作瞬时返回，严禁持久化或写入日志。
 */
export const lakalaOnboardingApplications = pgTable(
  'lakala_onboarding_applications',
  {
    id: text('id').primaryKey(),
    /** 业务申请号，不复用销售订单号。 */
    applicationNo: text('application_no').notNull(),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.storeId, { onDelete: 'restrict', onUpdate: 'cascade' }),
    status: text('status').$type<LakalaOnboardingStatus>().notNull().default('DRAFT'),
    merchantData: jsonb('merchant_data').notNull().default(sql`'{}'::jsonb`),
    legalPersonData: jsonb('legal_person_data').notNull().default(sql`'{}'::jsonb`),
    contactData: jsonb('contact_data').notNull().default(sql`'{}'::jsonb`),
    settlementData: jsonb('settlement_data').notNull().default(sql`'{}'::jsonb`),
    shopData: jsonb('shop_data').notNull().default(sql`'{}'::jsonb`),
    terminalData: jsonb('terminal_data').notNull().default(sql`'{}'::jsonb`),
    /** 只记录服务端费率策略版本，不保存或回传具体费率。 */
    feePolicyVersion: text('fee_policy_version'),
    eContractOrderNo: text('e_contract_order_no'),
    eContractApplyId: text('e_contract_apply_id'),
    eContractNo: text('e_contract_no'),
    /** 保留拉卡拉原始合同状态，避免第三方状态扩展导致数据写入失败。 */
    eContractStatus: text('e_contract_status'),
    eContractSignedAt: timestamp('e_contract_signed_at', { withTimezone: true, precision: 3 }),
    contractId: text('contract_id'),
    merInnerNo: text('mer_inner_no'),
    merCupNo: text('mer_cup_no'),
    /** 微信、支付宝子商户与受控轮询状态。 */
    channelData: jsonb('channel_data').notNull().default(sql`'{}'::jsonb`),
    subMerchantCheckedAt: timestamp('sub_merchant_checked_at', { withTimezone: true, precision: 3 }),
    /** 审核成功后创建或复用的收款商户档案；解绑时保留入网历史。 */
    lakalaMerchantId: text('lakala_merchant_id').references(() => lakalaMerchants.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    submittedAt: timestamp('submitted_at', { withTimezone: true, precision: 3 }),
    createdByEmployeeId: varchar('created_by_employee_id', { length: 30 }),
    createdByName: text('created_by_name'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    /** 写操作用作乐观锁令牌。 */
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    uniqueIndex('uq_lakala_onboarding_application_no').on(table.applicationNo),
    uniqueIndex('uq_lakala_onboarding_active_store')
      .on(table.storeId)
      .where(sql`${table.status} NOT IN ('SUCCESS', 'FAILED', 'CANCELLED')`),
    uniqueIndex('uq_lakala_onboarding_mer_cup_no')
      .on(table.merCupNo)
      .where(sql`${table.merCupNo} IS NOT NULL`),
    uniqueIndex('uq_lakala_onboarding_econtract_order_no')
      .on(table.eContractOrderNo)
      .where(sql`${table.eContractOrderNo} IS NOT NULL`),
    index('idx_lakala_onboarding_store_updated_at').on(table.storeId, table.updatedAt.desc()),
    index('idx_lakala_onboarding_status_updated_at').on(table.status, table.updatedAt.desc()),
    index('idx_lakala_onboarding_submerchant_poll')
      .on(table.status, table.subMerchantCheckedAt)
      .where(sql`${table.status} = 'SUCCESS' AND ${table.merCupNo} IS NOT NULL`),
    check(
      'chk_lakala_onboarding_application_status',
      sql`${table.status} IN ('DRAFT', 'FILES_UPLOADING', 'FILES_READY', 'SUBMITTING', 'SUBMITTED', 'REGISTERING', 'SUCCESS', 'FAILED', 'CANCELLED')`,
    ),
  ],
)

/**
 * 私有资料附件元数据。storageKey 是存储后端的不可猜测键，不保存容器绝对路径或
 * 可公开访问的 URL；已下载的电子合同 PDF 也通过 attachmentType='E_CONTRACT_PDF' 存入。
 */
export const lakalaOnboardingAttachments = pgTable(
  'lakala_onboarding_attachments',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id')
      .notNull()
      .references(() => lakalaOnboardingApplications.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    attachmentType: text('attachment_type').notNull(),
    displayName: text('display_name').notNull(),
    storageKey: text('storage_key').notNull(),
    originalFilename: text('original_filename').notNull(),
    fileExt: varchar('file_ext', { length: 20 }),
    fileSizeBytes: integer('file_size_bytes').notNull(),
    contentType: varchar('content_type', { length: 255 }),
    contentSha256: varchar('content_sha256', { length: 64 }).notNull(),
    status: text('status').$type<LakalaOnboardingAttachmentStatus>().notNull().default('LOCAL_SAVED'),
    lakalaFileId: text('lakala_file_id'),
    lakalaFileReference: text('lakala_file_reference'),
    lakalaBatchNo: text('lakala_batch_no'),
    lakalaOcrStatus: text('lakala_ocr_status'),
    uploadedToLakalaAt: timestamp('uploaded_to_lakala_at', { withTimezone: true, precision: 3 }),
    expiresAt: timestamp('expires_at', { withTimezone: true, precision: 3 }),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    uniqueIndex('uq_lakala_onboarding_attachment_storage_key').on(table.storageKey),
    index('idx_lakala_onboarding_attachment_application').on(table.applicationId, table.createdAt.desc()),
    index('idx_lakala_onboarding_attachment_type').on(table.applicationId, table.attachmentType),
    index('idx_lakala_onboarding_attachment_status').on(table.applicationId, table.status),
    check('chk_lakala_onboarding_attachment_file_size', sql`${table.fileSizeBytes} > 0`),
    check('chk_lakala_onboarding_attachment_storage_key', sql`length(${table.storageKey}) > 0`),
    check(
      'chk_lakala_onboarding_attachment_sha256',
      sql`${table.contentSha256} ~ '^[A-Fa-f0-9]{64}$'`,
    ),
    check(
      'chk_lakala_onboarding_attachment_status',
      sql`${table.status} IN ('LOCAL_SAVED', 'UPLOADING', 'UPLOADED', 'EXPIRED', 'FAILED', 'DELETED')`,
    ),
  ],
)

/**
 * 拉卡拉和电子合同的外部调用记录。request/response 字段只能保存经服务端递归脱敏
 * 的结构化内容，禁止保存身份证、银行卡、手机号、合同链接、Base64 或密钥。
 */
export const lakalaOnboardingRequestLogs = pgTable(
  'lakala_onboarding_request_logs',
  {
    id: text('id').primaryKey(),
    applicationId: text('application_id').references(() => lakalaOnboardingApplications.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    apiName: text('api_name').notNull(),
    requestId: text('request_id').notNull(),
    idempotencyKey: text('idempotency_key'),
    attemptNo: integer('attempt_no').notNull().default(1),
    requestPayloadMasked: jsonb('request_payload_masked').notNull().default(sql`'{}'::jsonb`),
    responsePayloadMasked: jsonb('response_payload_masked').notNull().default(sql`'{}'::jsonb`),
    httpStatus: integer('http_status'),
    status: text('status').$type<LakalaOnboardingRequestLogStatus>().notNull().default('PENDING'),
    externalRequestId: text('external_request_id'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, precision: 3 }),
  },
  (table) => [
    uniqueIndex('uq_lakala_onboarding_request_log_request_id').on(table.requestId),
    uniqueIndex('uq_lakala_onboarding_request_log_idempotency_attempt')
      .on(table.applicationId, table.apiName, table.idempotencyKey, table.attemptNo)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index('idx_lakala_onboarding_request_log_application').on(table.applicationId, table.startedAt.desc()),
    index('idx_lakala_onboarding_request_log_api').on(table.apiName, table.startedAt.desc()),
    check('chk_lakala_onboarding_request_log_attempt', sql`${table.attemptNo} > 0`),
    check(
      'chk_lakala_onboarding_request_log_status',
      sql`${table.status} IN ('PENDING', 'SUCCEEDED', 'FAILED')`,
    ),
  ],
)

export type LakalaOnboardingApplication = typeof lakalaOnboardingApplications.$inferSelect
export type NewLakalaOnboardingApplication = typeof lakalaOnboardingApplications.$inferInsert
export type LakalaOnboardingAttachment = typeof lakalaOnboardingAttachments.$inferSelect
export type NewLakalaOnboardingAttachment = typeof lakalaOnboardingAttachments.$inferInsert
export type LakalaOnboardingRequestLog = typeof lakalaOnboardingRequestLogs.$inferSelect
export type NewLakalaOnboardingRequestLog = typeof lakalaOnboardingRequestLogs.$inferInsert
