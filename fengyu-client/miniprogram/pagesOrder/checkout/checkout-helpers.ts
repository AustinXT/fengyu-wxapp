/**
 * checkout 页面 — 储值卡抵扣相关纯函数
 *
 * 后端 (clientApi.order.create / scanAdjust) 是权威方：
 * 此处仅做前端预览/UI 联动用。最终生效以接口返回的 paid_amount / prepaid_card_amount 为准。
 *
 * 规则参见 ticket §2.1：
 *  - 余额 = 0 → 开关禁用，prepaid = 0
 *  - 余额 ≥ 应抵扣部分 (totalAmount - couponDiscount) → 默认开，prepaid = 应抵扣，paid = 0
 *  - 余额 < 应抵扣部分 → 默认开，prepaid = 余额，paid = diff
 *  - 用户手动关闭 useCard → prepaid = 0, paid = 应抵扣
 */

export interface RecomputeInput {
  totalAmount: number;     // 商品合计（未扣券）
  couponDiscount: number;  // 优惠券抵扣
  pointsBalance: number;   // 可用积分余额
  usePoints: boolean;      // 是否启用积分抵扣
  pointsUsed?: number;     // 指定使用积分；未传时按上限自动计算
  pointsToYuanRate: number; // 积分折算元比例
  pointsDeductionMaxRate: number; // 抵扣上限比例
  cardBalance: number;     // 储值卡余额
  useCard: boolean;        // 用户开关
}

export interface RecomputeResult {
  prepaidCardAmount: number;   // 储值卡抵扣金额（不计入实付）
  pointsUsed: number;          // 使用积分
  pointsDiscount: number;      // 积分抵扣金额
  maxPointsUsable: number;     // 当前订单最多可用积分
  paidAmount: number;          // 实付金额（走支付通道）
  showPayMethodGroup: boolean; // 是否显示支付方式按钮组
  netBeforeCard: number;       // 应抵扣部分 = totalAmount - couponDiscount - pointsDiscount，便于 UI 复用
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function moneyToCents(n: number): number {
  return Math.max(0, Math.round((Number(n) || 0) * 100));
}

function pointsToDiscountCents(points: number, rate: number): number {
  return Math.floor(points * rate * 100 + 1e-6);
}

/** 保留 0：它是后台配置的合法值，表示禁用积分抵扣。 */
export function normalizePointsDeductionMaxRate(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0.03;
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0.03;
}

/**
 * 根据订单总额、优惠券、储值卡余额和开关状态计算抵扣明细
 */
export function recomputeAmounts(input: RecomputeInput): RecomputeResult {
  const total = Number(input.totalAmount) || 0;
  const coupon = Number(input.couponDiscount) || 0;
  const pointsBalance = Math.max(0, Math.floor(Number(input.pointsBalance) || 0));
  const pointsRate = Number(input.pointsToYuanRate) || 0.01;
  const maxRate = Number(input.pointsDeductionMaxRate) || 0;
  const balance = Math.max(0, Number(input.cardBalance) || 0);

  const netAfterCoupon = round2(Math.max(0, total - coupon));
  const pointsCapCents = Math.min(
    moneyToCents(netAfterCoupon),
    Math.floor(Math.max(0, total) * maxRate * 100 + 1e-6),
  );
  const maxPointsUsable = pointsRate > 0
    ? Math.max(0, Math.min(pointsBalance, Math.floor(pointsCapCents / (pointsRate * 100))))
    : 0;
  const effectiveUsePoints = input.usePoints && pointsBalance > 0 && maxPointsUsable > 0;
  const rawRequested = input.pointsUsed !== undefined && input.pointsUsed !== null
    ? Math.floor(Number(input.pointsUsed) || 0)
    : maxPointsUsable;
  const pointsUsed = effectiveUsePoints
    ? Math.max(0, Math.min(rawRequested, maxPointsUsable))
    : 0;
  const pointsDiscount = pointsUsed > 0
    ? round2(Math.min(pointsCapCents, pointsToDiscountCents(pointsUsed, pointsRate)) / 100)
    : 0;

  // 应抵扣部分（券和积分后金额，最低 0，避免负数）
  const netBeforeCard = round2(Math.max(0, netAfterCoupon - pointsDiscount));

  // 余额 = 0 → useCard 被强制视为 false
  const effectiveUseCard = input.useCard && balance > 0 && netBeforeCard > 0;

  const prepaidCardAmount = effectiveUseCard
    ? round2(Math.min(balance, netBeforeCard))
    : 0;
  const paidAmount = round2(netBeforeCard - prepaidCardAmount);

  return {
    prepaidCardAmount,
    pointsUsed,
    pointsDiscount,
    maxPointsUsable,
    paidAmount,
    showPayMethodGroup: paidAmount > 0,
    netBeforeCard,
  };
}

// ─── 消费协议预览（结算页《协议》弹层） ───

export interface AgreementPara {
  /** 段落文本（已 trim） */
  text: string;
  /** 是否为标题行（「一、」「第N条」开头），前端加粗显示 */
  heading: boolean;
}

/** 标题行识别：「一、二、…」中文序号 + 顿号，或「第N条」 */
const AGREEMENT_HEADING_RE = /^(第[一二三四五六七八九十百千\d]+条|[一二三四五六七八九十]+、)/;

/**
 * 把协议正文（多段纯文本，\n 分隔）解析为段落数组。
 * 空行过滤（段间距交给样式），标题行打 heading 标记。
 */
export function parseAgreement(content: string): AgreementPara[] {
  return String(content || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => ({ text: line, heading: AGREEMENT_HEADING_RE.test(line) }));
}

/**
 * 内置兜底协议文案（美容院通用）。
 * 当 admin 未配置（config.consumeAgreement 返回 content 为空）或接口异常时使用。
 * ⚠️ 与 fengyu-admin src/lib/consume-agreement.ts 的 DEFAULT_AGREEMENT_CONTENT 文案手工对齐
 * （项目禁止跨端共享代码目录，各端保留独立副本）。
 */
export const DEFAULT_AGREEMENT_TEXT = `一、服务内容与适用范围
本协议适用于您在凤御美容院（含旗下各门店）购买的护理服务、家居产品、储值卡及疗程卡等消费项目。您下单并完成支付，即视为已阅读、理解并同意本协议全部条款。

二、预约与到店
护理服务建议提前预约，门店将根据预约时间为您安排美容师及护理房间。如需取消或调整预约，请提前与门店联系；多次爽约可能影响后续预约的优先安排。

三、付款与价格
商品及服务价格以下单时页面显示的金额为准。您可使用微信支付、支付宝或到店线下付款；选择线下付款的订单需到店由门店确认收款后方视为完成。促销价格、优惠券及储值卡抵扣均以结算页实际展示为准。

四、储值卡与疗程卡
储值卡余额与疗程卡剩余次数为您的账户资产，可跨本品牌门店使用，不与单一门店绑定。余额及次数的有效期、转让规则以购买时的活动说明或门店公示为准。储值卡原则上不可兑换现金。

五、退款与退卡
未开始服务的订单可按门店退款规则申请退款；已进行部分服务或已拆零使用的疗程卡，门店将按实际消耗及剩余价值核算可退金额。退款金额由门店线下处理，具体到账方式和时间以门店确认为准。

六、健康告知与顾客责任
接受护理服务前，请如实告知皮肤状况、过敏史、近期手术或重大疾病等健康信息，以便美容师评估并调整方案。因隐瞒重要健康信息导致的不适或损害，门店不承担相应责任。请您妥善保管随身贵重物品。

七、个人信息与隐私保护
为向您提供服务，我们会收集并使用您的手机号、消费记录、护理档案等必要信息，并依法严格保密，不向无关第三方泄露。您有权查询、更正本人的相关信息。

八、免责声明
因不可抗力（如自然灾害、公共卫生事件、政府管制等）导致服务无法正常提供的，门店将与您协商改期或办理退款，不视为违约。因个体差异，护理效果可能存在差异，相关效果描述不构成医疗承诺。

九、协议变更与解释权
本协议条款可能根据法律法规及经营需要适时更新，更新后将在小程序内公示。在法律允许的范围内，本协议最终解释权归凤御美容院所有。如有疑问，请咨询门店工作人员。`;
