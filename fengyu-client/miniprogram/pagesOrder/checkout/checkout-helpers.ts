

export interface RecomputeInput {
  totalAmount: number;     
  couponDiscount: number;  
  cardBalance: number;     
  useCard: boolean;        
}

export interface RecomputeResult {
  prepaidCardAmount: number;   
  paidAmount: number;          
  showPayMethodGroup: boolean; 
  netBeforeCard: number;       
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}


export function recomputeAmounts(input: RecomputeInput): RecomputeResult {
  const total = Number(input.totalAmount) || 0;
  const coupon = Number(input.couponDiscount) || 0;
  const balance = Math.max(0, Number(input.cardBalance) || 0);

  
  const netBeforeCard = round2(Math.max(0, total - coupon));

  
  const effectiveUseCard = input.useCard && balance > 0 && netBeforeCard > 0;

  const prepaidCardAmount = effectiveUseCard
    ? round2(Math.min(balance, netBeforeCard))
    : 0;
  const paidAmount = round2(netBeforeCard - prepaidCardAmount);

  return {
    prepaidCardAmount,
    paidAmount,
    showPayMethodGroup: paidAmount > 0,
    netBeforeCard,
  };
}



export interface AgreementPara {
  
  text: string;
  
  heading: boolean;
}


const AGREEMENT_HEADING_RE = /^(第[一二三四五六七八九十百千\d]+条|[一二三四五六七八九十]+、)/;


export function parseAgreement(content: string): AgreementPara[] {
  return String(content || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => ({ text: line, heading: AGREEMENT_HEADING_RE.test(line) }));
}


export const DEFAULT_AGREEMENT_TEXT = `一、服务内容与适用范围
本协议适用于您在凤御美容院（含旗下各门店）购买的护理服务、家居产品、储值卡及疗程卡等消费项目。您下单并完成支付，即视为已阅读、理解并同意本协议全部条款。

二、预约与到店
护理服务建议提前预约，门店将根据预约时间为您安排美容师及护理房间。如需取消或调整预约，请提前与门店联系；多次爽约可能影响后续预约的优先安排。

三、付款与价格
商品及服务价格以下单时页面显示的金额为准。您可使用微信支付、支付宝或到店线下付款；选择线下付款的订单需到店由门店确认收款后方视为完成。促销价格、优惠券及储值卡抵扣均以结算页实际展示为准。

四、储值卡与疗程卡
储值卡余额与疗程卡剩余次数为您的账户资产，可跨本品牌门店使用，不与单一门店绑定。余额及次数的有效期、转让规则以购买时的活动说明或门店公示为准。储值卡原则上不可兑换现金。

五、退款与退卡
未开始服务的订单可按门店退款规则申请退款；已进行部分服务或已拆零使用的疗程卡，门店将按实际消耗及剩余价值核算可退金额。退款原路退回至您的支付账户，到账时间以支付渠道为准。

六、健康告知与顾客责任
接受护理服务前，请如实告知皮肤状况、过敏史、近期手术或重大疾病等健康信息，以便美容师评估并调整方案。因隐瞒重要健康信息导致的不适或损害，门店不承担相应责任。请您妥善保管随身贵重物品。

七、个人信息与隐私保护
为向您提供服务，我们会收集并使用您的手机号、消费记录、护理档案等必要信息，并依法严格保密，不向无关第三方泄露。您有权查询、更正本人的相关信息。

八、免责声明
因不可抗力（如自然灾害、公共卫生事件、政府管制等）导致服务无法正常提供的，门店将与您协商改期或办理退款，不视为违约。因个体差异，护理效果可能存在差异，相关效果描述不构成医疗承诺。

九、协议变更与解释权
本协议条款可能根据法律法规及经营需要适时更新，更新后将在小程序内公示。在法律允许的范围内，本协议最终解释权归凤御美容院所有。如有疑问，请咨询门店工作人员。`;
