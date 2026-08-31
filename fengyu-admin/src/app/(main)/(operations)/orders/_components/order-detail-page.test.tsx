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

import { calculateConfirmOfflineAmounts } from "./order-detail-page";

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
