import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { stores } from "./org";

export const lakalaOnboardingApplications = pgTable(
  "lakala_onboarding_applications",
  {
    id: text("id").primaryKey(),
    orderNo: text("order_no").notNull().unique(),
    storeId: text("store_id").notNull().references(() => stores.storeId, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),
    status: text("status").notNull().default("DRAFT"),
    merchantData: jsonb("merchant_data").notNull().default(sql`'{}'::jsonb`),
    legalPersonData: jsonb("legal_person_data").notNull().default(sql`'{}'::jsonb`),
    contactData: jsonb("contact_data").notNull().default(sql`'{}'::jsonb`),
    settlementData: jsonb("settlement_data").notNull().default(sql`'{}'::jsonb`),
    shopData: jsonb("shop_data").notNull().default(sql`'{}'::jsonb`),
    terminalData: jsonb("terminal_data").notNull().default(sql`'{}'::jsonb`),
    feeData: jsonb("fee_data").notNull().default(sql`'[]'::jsonb`),
    lakalaRequestData: jsonb("lakala_request_data").notNull().default(sql`'{}'::jsonb`),
    eContractOrderNo: text("e_contract_order_no"),
    eContractApplyId: text("e_contract_apply_id"),
    eContractResultUrl: text("e_contract_result_url"),
    eContractNo: text("e_contract_no"),
    eContractStatus: text("e_contract_status"),
    eContractSignedAt: timestamp("e_contract_signed_at", { withTimezone: true }),
    contractId: text("contract_id"),
    merInnerNo: text("mer_inner_no"),
    merCupNo: text("mer_cup_no"),
    channelData: jsonb("channel_data").notNull().default(sql`'{}'::jsonb`),
    subMerchantCheckedAt: timestamp("sub_merchant_checked_at", { withTimezone: true }),
    lakalaMerchantId: text("lakala_merchant_id"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdByName: text("created_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    index("idx_lakala_onboarding_store_id").on(table.storeId),
    index("idx_lakala_onboarding_status").on(table.status),
    uniqueIndex("uq_lakala_onboarding_active_store")
      .on(table.storeId)
      .where(sql`${table.status} NOT IN ('SUCCESS', 'FAILED', 'CANCELLED')`),
  ],
);

export const lakalaOnboardingAttachments = pgTable(
  "lakala_onboarding_attachments",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id").notNull().references(() => lakalaOnboardingApplications.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    attType: text("att_type").notNull(),
    displayName: text("display_name").notNull(),
    localPath: text("local_path").notNull(),
    fileName: text("file_name").notNull(),
    fileExt: text("file_ext"),
    fileSize: text("file_size").notNull(),
    mimeType: text("mime_type"),
    status: text("status").notNull().default("LOCAL_SAVED"),
    attFileId: text("att_file_id"),
    lakalaFileUrl: text("lakala_file_url"),
    lakalaShowUrl: text("lakala_show_url"),
    lakalaBatchNo: text("lakala_batch_no"),
    lakalaOcrStatus: text("lakala_ocr_status"),
    uploadedToLakalaAt: timestamp("uploaded_to_lakala_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastErrorMessage: text("last_error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => sql`NOW()`),
  },
  (table) => [
    index("idx_lakala_onboarding_attachments_app").on(table.applicationId),
    index("idx_lakala_onboarding_attachments_display").on(table.applicationId, table.displayName),
  ],
);

export const lakalaOnboardingRequestLogs = pgTable(
  "lakala_onboarding_request_logs",
  {
    id: text("id").primaryKey(),
    applicationId: text("application_id").references(() => lakalaOnboardingApplications.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    apiName: text("api_name").notNull(),
    requestId: text("request_id").notNull(),
    requestPayloadMasked: jsonb("request_payload_masked").notNull().default(sql`'{}'::jsonb`),
    responsePayload: jsonb("response_payload").notNull().default(sql`'{}'::jsonb`),
    success: boolean("success").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_lakala_onboarding_logs_app").on(table.applicationId),
    index("idx_lakala_onboarding_logs_api").on(table.apiName),
  ],
);

export type LakalaOnboardingApplication = typeof lakalaOnboardingApplications.$inferSelect;
export type NewLakalaOnboardingApplication = typeof lakalaOnboardingApplications.$inferInsert;
export type LakalaOnboardingAttachment = typeof lakalaOnboardingAttachments.$inferSelect;
export type LakalaOnboardingRequestLog = typeof lakalaOnboardingRequestLogs.$inferSelect;
