import { describe, expect, it, vi } from "vitest";

vi.mock("@/actions/orders", () => ({
  approveDepositOrder: vi.fn(),
  deleteOrder: vi.fn(),
  rejectDepositOrder: vi.fn(),
}));
vi.mock("@/components/orders/refund-form", () => ({ RefundForm: () => null }));
vi.mock("@/components/delete-action", () => ({ DangerZoneDelete: () => null }));
vi.mock("./record-payment-dialog", () => ({ RecordPaymentDialog: () => null }));
vi.mock("./confirm-offline-dialog", () => ({ ConfirmOfflineDialog: () => null }));
vi.mock("./performance-attribution-dialog", () => ({ PerformanceAttributionDialog: () => null }));
vi.mock("./payment-performance-attribution-dialog", () => ({ PaymentPerformanceAttributionDialog: () => null }));

import type { SaleOrderPayment } from "@/lib/types";
import {
  calculateConfirmOfflineAmounts,
  canEditPaymentPerformanceAttribution,
  mergePaymentsForDisplay,
} from "./order-detail-page";

describe("calculateConfirmOfflineAmounts", () => {
  it("预选储值卡时按持久化 payableAmount 初始化并限制确认金额", () => {
    const result = calculateConfirmOfflineAmounts(
      {
        payableAmount: "140.00",
        received: "0.00",
        saleOrderType: "销售单",
        firstPaymentAmount: null,
      },
      [{ pendingReceived: "200.00" }],
    );

    expect(result).toEqual({ remainingPayable: 140, suggestedAmount: 140 });
  });

  it("已确认现金会从 payableAmount 扣除，约定实付仍不会突破剩余上限", () => {
    const result = calculateConfirmOfflineAmounts(
      {
        payableAmount: "140.00",
        received: "40.00",
        saleOrderType: "销售单",
        firstPaymentAmount: null,
      },
      [{ pendingReceived: "200.00" }],
    );

    expect(result).toEqual({ remainingPayable: 100, suggestedAmount: 100 });
  });
});

describe("mergePaymentsForDisplay", () => {
  const payment = (overrides: Partial<SaleOrderPayment>): SaleOrderPayment => ({
    id: 1,
    saleOrderId: "FY-XSD-WX-2608170001",
    changeType: "回款",
    amount: "60.00",
    paymentMethod: "线下",
    externalTxnId: null,
    status: "已支付",
    sourceEnd: "admin",
    operatorEmployeeId: "EMP-001",
    note: null,
    createdAt: "2026-08-17T02:03:04.567Z",
    paidAt: "2026-08-17T02:03:04.567Z",
    performanceAttributionDate: "2026-08-20",
    performanceAttributionAdjustedAt: null,
    performanceAttributionAdjustedBy: null,
    ...overrides,
  });

  it("无论卡流水顺序如何都保留现付主流水及其归属字段", () => {
    const card = payment({
      id: 2,
      changeType: "储值卡抵扣",
      amount: "40.00",
      paymentMethod: "储值卡",
      performanceAttributionDate: "2026-08-17",
    });
    const primary = payment({ id: 1 });

    const result = mergePaymentsForDisplay([card, primary]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 1,
      amount: "100",
      performanceAttributionDate: "2026-08-20",
    });
    expect(result[0].note).toContain("其中储值卡 ¥40");
  });

  it("纯储值卡支付没有现付主流水时仍独立展示", () => {
    const card = payment({ id: 2, changeType: "储值卡抵扣", paymentMethod: "储值卡" });
    expect(mergePaymentsForDisplay([card])).toEqual([card]);
  });

  it("混合支付配对刷卡流水不能显示归属修改入口", () => {
    const primary = payment({ id: 1 });
    const card = payment({ id: 2, changeType: "储值卡抵扣", paymentMethod: "储值卡" });

    expect(canEditPaymentPerformanceAttribution(true, primary, [primary, card])).toBe(true);
    expect(canEditPaymentPerformanceAttribution(true, card, [primary, card])).toBe(false);
  });

  it("纯储值卡流水仍可单独修改归属日期", () => {
    const card = payment({ id: 2, changeType: "储值卡抵扣", paymentMethod: "储值卡" });
    expect(canEditPaymentPerformanceAttribution(true, card, [card])).toBe(true);
  });
});
