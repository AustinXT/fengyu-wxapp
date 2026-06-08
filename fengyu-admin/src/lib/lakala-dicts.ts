/**
 * 拉卡拉入网数据字典（静态版）
 *
 * 来源：docs/lakala-onboarding-endpoints.md §D2-D11
 * 范围：仅高频字典（凤御场景下用得到的）+「其它」兜底。
 * 完整字典（如完整 MCC 30+ 大类）需调用拉卡拉字典查询接口动态拉取，本期不做。
 *
 * 使用约定：
 *   import { POS_TYPES, POS_TYPE_LABEL } from '@/lib/lakala-dicts'
 *   const label = POS_TYPE_LABEL['WECHAT_PAY']      // '专业化扫码'
 *
 * 兜底：每个字典末尾保留 'OTHERS' / '99' 等「其它」码，UI 表单允许手填别名。
 */

// ---------------------------------------------------------------------------
// D2. 经营内容字典表（merBusiContent）
// ---------------------------------------------------------------------------
export const MER_BUSI_CONTENTS = [
  { code: '640', label: '餐饮、宾馆、娱乐、珠宝金饰、工艺美术品' }, // 凤御推荐
  { code: '641', label: '房地产汽车类' },
  { code: '642', label: '百货、中介、培训、景区门票等' },
  { code: '643', label: '批发类商户' },
  { code: '644', label: '加油、超市类' },
  { code: '645', label: '交通运输售票' },
  { code: '646', label: '水电气缴费' },
  { code: '647', label: '政府类' },
  { code: '648', label: '便民类' },
  { code: '649', label: '公立医院、公立学校、慈善' },
  { code: '650', label: '宾馆餐饮娱乐类' },
  { code: '651', label: '房产汽车类' },
  { code: '652', label: '批发类' },
  { code: '653', label: '超市加油类' },
  { code: '654', label: '一般类商户' },
  { code: '655', label: '三农商户' },
] as const

export const MER_BUSI_CONTENT_LABEL: Record<string, string> = Object.fromEntries(
  MER_BUSI_CONTENTS.map((x) => [x.code, x.label]),
)

// ---------------------------------------------------------------------------
// D3. POS 类型字典表（posType）
// ---------------------------------------------------------------------------
export const POS_TYPES = [
  { code: 'WECHAT_PAY', label: '专业化扫码' }, // 凤御固定使用
  { code: 'GENERAL_POS', label: '传统 POS' },
  { code: 'SUPER_POS', label: '智能 POS' },
  { code: 'BLUE_WIZARD', label: '蓝精灵' },
  { code: 'SQB_SCAN_CODE', label: '收钱吧扫码' },
  { code: 'SQB_PAPER_CODE', label: '收钱吧码牌' },
  { code: 'SQB_DESK_CODE', label: '收钱吧桌码' },
  { code: 'SQB_POS', label: '收钱吧 POS' },
  { code: 'B2B_CASHIER_DESK', label: 'B2B 收银台' },
  { code: 'B2B_QR_CODE', label: 'B2B 收款码' },
  { code: 'MOBILE_POS', label: '手机 POS' },
  { code: 'OTHERS', label: '其它（手填）' },
] as const

export const POS_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  POS_TYPES.map((x) => [x.code, x.label]),
)

// ---------------------------------------------------------------------------
// D4. 业务类型字典表（busiTypeCode）
// ---------------------------------------------------------------------------
export const BUSI_TYPES = [
  { code: 'BANK_CARD', label: '银行卡' },
  { code: 'WILD_CARD', label: '外卡' },
  { code: 'QR_CODE_CARD', label: '扫码' },
  { code: 'BIG_AMOUNT_FINANCE', label: '大额理财' },
  { code: 'E_BANK', label: '银行卡网银' },
] as const

export const BUSI_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  BUSI_TYPES.map((x) => [x.code, x.label]),
)

// ---------------------------------------------------------------------------
// D5. 结算周期字典表（settlePeriod）
// ---------------------------------------------------------------------------
export const SETTLE_PERIODS = [
  { code: 'T+1', label: 'T+1 结算（T 日 05:30-09:30）' }, // 凤御使用
  { code: 'T+1+N', label: 'T+1 普通结算批次（T 日 12:00-15:00）' },
  { code: 'T+3', label: '收单 T+3 结算' },
  { code: 'D+1', label: '收单 D+1 结算批次（D 日 05:30）' },
  { code: 'D+1+N', label: 'D+1 普通结算批次' },
  { code: 'D1+24', label: 'D1+24 结算批次（D 日 11:00）' },
  { code: 'D+30', label: '收单 D+30 结算' },
  { code: 'BT_D+1', label: 'D+1 四方补贴结算批次' },
  { code: 'QZT_FULL_D+1', label: '钱账通 D+1 全额结算批次' },
  { code: 'QZT_NET_D+1', label: '钱账通 D+1 净额结算批次' },
  { code: 'FS', label: '灵活结算（汇拓客专用）' },
  { code: 'W_T+9999', label: '喔噻 T+9999 不结算批次' },
] as const

export const SETTLE_PERIOD_LABEL: Record<string, string> = Object.fromEntries(
  SETTLE_PERIODS.map((x) => [x.code, x.label]),
)

// ---------------------------------------------------------------------------
// D6. 证件类型字典表（larIdType / acctIdType，进件接口用）
// ---------------------------------------------------------------------------
export const CERT_TYPES = [
  { code: '01', label: '身份证' },
  { code: '02', label: '护照' },
  { code: '03', label: '港澳通行证' },
  { code: '04', label: '台胞证' },
  { code: '10', label: '外国人永久居留身份证' },
  { code: '11', label: '港澳居民居住证' },
  { code: '12', label: '台湾居民居住证' },
  { code: '13', label: '执行事务合伙人' },
  { code: '99', label: '其它证件' },
] as const

export const CERT_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  CERT_TYPES.map((x) => [x.code, x.label]),
)

// ---------------------------------------------------------------------------
// D6'. 电子合同证件类型（cert_type，v3 电子合同接口专用）
// 与进件接口 larIdType 不同码值，调用时需做映射。
// ---------------------------------------------------------------------------
export const EC_CERT_TYPES = [
  { code: 'RESIDENT_ID', label: '身份证' },
  { code: 'PASSPORT', label: '护照' },
  { code: 'HK_MACAO_PASS', label: '港澳通行证' },
  { code: 'TAIWAN_PASS', label: '台胞证' },
] as const

export const EC_CERT_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  EC_CERT_TYPES.map((x) => [x.code, x.label]),
)

/**
 * larIdType (01/02/03/04) → cert_type (RESIDENT_ID/PASSPORT/HK_MACAO_PASS/TAIWAN_PASS) 映射
 * 缺省（10/11/12/13/99 等）→ RESIDENT_ID 兜底。
 */
export const LAR_ID_TYPE_TO_EC_CERT_TYPE: Record<string, string> = {
  '01': 'RESIDENT_ID',
  '02': 'PASSPORT',
  '03': 'HK_MACAO_PASS',
  '04': 'TAIWAN_PASS',
}

// ---------------------------------------------------------------------------
// D7. 限额类型字典表（limitTypeCode）
// ---------------------------------------------------------------------------
export const LIMIT_TYPES = [
  { code: 'BANK_DEBIT_CARD', label: '银行借记卡' },
  { code: 'BANK_CREDIT_CARD', label: '银行贷记卡' },
  { code: 'QR_CODE_CARD', label: '扫码' },
  { code: 'WILD_CARD', label: '外卡' },
  { code: 'RETURNS_ONLINE', label: '联机退货' },
  { code: 'PAPER_CODE', label: '纸码' },
] as const

export const LIMIT_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  LIMIT_TYPES.map((x) => [x.code, x.label]),
)

// ---------------------------------------------------------------------------
// D8. 商户状态字典表（merStatus / shopStatus / busiStatus）
// ---------------------------------------------------------------------------
export const MER_STATUSES = [
  { code: 'VALID', label: '有效' },
  { code: 'INVALID', label: '无效' },
] as const

export const MER_STATUS_LABEL: Record<string, string> = Object.fromEntries(
  MER_STATUSES.map((x) => [x.code, x.label]),
)

// ---------------------------------------------------------------------------
// D10. MCC 对照表（餐娱类摘录）
// 凤御默认 7298 保健及美容 SPA。
// ---------------------------------------------------------------------------
export const MCC_CODES = [
  { code: '7298', label: '保健及美容 SPA' }, // 凤御推荐
  { code: '7297', label: '按摩店' },
  { code: '5094', label: '贵重珠宝、首饰、钟表零售' },
  { code: '5811', label: '包办伙食、宴会承包商' },
  { code: '5812', label: '就餐场所和餐馆' },
  { code: '5813', label: '饮酒场所（酒吧、酒馆、夜总会等）' },
  { code: '5932', label: '古玩店——出售、维修及还原' },
  { code: '5937', label: '古玩复制店' },
  { code: '5944', label: '银器店' },
  { code: '5950', label: '玻璃器皿和水晶饰品店' },
  { code: '5970', label: '工艺美术商店' },
  { code: '5971', label: '艺术商和画廊' },
  { code: '7011', label: '住宿服务（旅馆、酒店、汽车旅馆、度假村等）' },
  { code: '7012', label: '分时使用的别墅或度假用房' },
  { code: '7032', label: '运动和娱乐露营地' },
  { code: '7033', label: '活动房车场及露营场所' },
  { code: '7631', label: '手表、钟表和首饰维修店' },
  { code: '7829', label: '电影和录像创作、发行' },
  { code: '7911', label: '歌舞厅' },
  { code: '7922', label: '戏剧制片（不含电影）、演出和票务' },
  { code: '7929', label: '未列入其他代码的乐队、文艺表演' },
  { code: '7932', label: '台球、撞球场所' },
  { code: '7933', label: '保龄球馆' },
  { code: '7941', label: '商业体育场馆、职业体育俱乐部、运动场和体育推广公司' },
  { code: '7992', label: '公共高尔夫球场' },
  { code: '7994', label: '大型游戏机和游戏场所' },
  { code: '7996', label: '游乐园、马戏团、嘉年华、占卜' },
  { code: '7997', label: '会员俱乐部、乡村俱乐部、私人高尔夫课程班' },
  { code: '7998', label: '水族馆、海洋馆和海豚馆' },
  { code: '7999', label: '未列入其他代码的娱乐服务' },
] as const

export const MCC_CODE_LABEL: Record<string, string> = Object.fromEntries(
  MCC_CODES.map((x) => [x.code, x.label]),
)

// ---------------------------------------------------------------------------
// D11. 附件类型枚举（拉卡拉 attType）
// 与 db enum lakala_attachment_type 同义但码值不同（DB 枚举=语义码 / 拉卡拉=拉卡拉规范码）。
// ---------------------------------------------------------------------------
export const ATTACHMENT_TYPES = [
  { code: 'FR_ID_CARD_FRONT', label: '法人身份证正面' },
  { code: 'FR_ID_CARD_BEHIND', label: '法人身份证反面' },
  { code: 'ID_CARD_FRONT', label: '结算人身份证正面' },
  { code: 'ID_CARD_BEHIND', label: '结算人身份证反面' },
  { code: 'BANK_CARD', label: '银行卡' },
  { code: 'BUSINESS_LICENCE', label: '营业执照' },
  { code: 'MERCHANT_PHOTO', label: '商户门头照' },
  { code: 'SHOPINNER', label: '商铺内部照片' },
  { code: 'XY', label: '线下纸质协议' },
  { code: 'NETWORK_XY', label: '电子协议' },
  { code: 'HT', label: '租赁合同' },
  { code: 'COOPERATION_QUALIFICATION_PROOF', label: '合作资质证明' },
  { code: 'FOOD_QUALIFICATION_PROOF', label: '食品经营相关资质' },
  { code: 'NO_LEGAL_PERSON_SETT_AUTH_LETTER', label: '非法人结算授权书' },
  { code: 'SPLIT_ENTRUST_FILE', label: '结算授权委托书' },
  { code: 'RENTAL_AGREEMENT', label: '集市方与场地方间的租赁协议' },
  { code: 'SPLIT_COOPERATION_FILE', label: '集市方与摊主间的合作协议' },
  { code: 'OTHERS', label: '其它' },
] as const

export const ATTACHMENT_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  ATTACHMENT_TYPES.map((x) => [x.code, x.label]),
)

/**
 * 凤御进件必传附件（按 endpoints 文档「必传」列）
 * 用于 submitMerchant 前置校验。
 */
export const REQUIRED_ATTACHMENT_TYPES_FOR_SUBMIT = [
  'FR_ID_CARD_FRONT',
  'FR_ID_CARD_BEHIND',
  'BANK_CARD',
  'BUSINESS_LICENCE', // 企业商户必传，小微可选；本期默认必传
  'MERCHANT_PHOTO',
  'SHOPINNER',
] as const

// ---------------------------------------------------------------------------
// 电子合同类型（拉卡拉 ec_type_code）
// ---------------------------------------------------------------------------
export const EC_TYPES = [
  { code: 'EC015', label: '特约商户支付服务合作协议V4.2（推荐）' },
  { code: 'EC010', label: '特约商户支付服务合作协议V4.1+清分授权' },
  { code: 'EC008', label: '特约商户支付服务合作协议V4.1（历史）' },
  { code: 'EC011', label: '清分结算授权委托书' },
] as const

export const EC_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  EC_TYPES.map((x) => [x.code, x.label]),
)

// ---------------------------------------------------------------------------
// 结算账户性质（acctTypeCode）
// ---------------------------------------------------------------------------
export const ACCT_TYPES = [
  { code: '57', label: '对公' },
  { code: '58', label: '对私' },
] as const

export const ACCT_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  ACCT_TYPES.map((x) => [x.code, x.label]),
)

// ---------------------------------------------------------------------------
// 进件状态字典（contractStatus，对应回调/查询响应）
// ---------------------------------------------------------------------------
export const LAKALA_CONTRACT_STATUSES = [
  { code: 'NO_COMMIT', label: '未提交' },
  { code: 'COMMIT', label: '已提交' },
  { code: 'COMMIT_FAIL', label: '提交失败' },
  { code: 'MANUAL_AUDIT', label: '转人工审核' },
  { code: 'REVIEW_ING', label: '审核中' },
  { code: 'WAIT_FOR_CONTACT', label: '审核通过' },
  { code: 'INNER_CHECK_REJECTED', label: '审核驳回' },
] as const

export const LAKALA_CONTRACT_STATUS_LABEL: Record<string, string> = Object.fromEntries(
  LAKALA_CONTRACT_STATUSES.map((x) => [x.code, x.label]),
)

// ---------------------------------------------------------------------------
// 微信实名申请状态（applymentState）
// ---------------------------------------------------------------------------
export const WX_APPLYMENT_STATES = [
  { code: 'APPLYMENT_STATE_FAIL', label: '提交失败' },
  { code: 'APPLYMENT_STATE_COMMIT', label: '已提交' },
  { code: 'APPLYMENT_STATE_WAITTING_FOR_AUDIT', label: '审核中' },
  { code: 'APPLYMENT_STATE_EDITTING', label: '编辑中' },
  { code: 'APPLYMENT_STATE_WAITTING_FOR_CONFIRM_CONTACT', label: '待确认联系信息' },
  { code: 'APPLYMENT_STATE_WAITTING_FOR_CONFIRM_LEGALPERSON', label: '待账户验证' },
  { code: 'APPLYMENT_STATE_PASSED', label: '审核通过' },
  { code: 'APPLYMENT_STATE_REJECTED', label: '审核驳回' },
  { code: 'APPLYMENT_STATE_FREEZED', label: '已冻结' },
  { code: 'APPLYMENT_STATE_CANCELED', label: '已作废' },
] as const

export const WX_APPLYMENT_STATE_LABEL: Record<string, string> = Object.fromEntries(
  WX_APPLYMENT_STATES.map((x) => [x.code, x.label]),
)

// ---------------------------------------------------------------------------
// 支付宝实名申请状态（applymentState）
// ---------------------------------------------------------------------------
export const ALIPAY_APPLYMENT_STATES = [
  { code: 'APPLYMENT_STATE_FAIL', label: '提交失败' },
  { code: 'APPLYMENT_STATE_COMMIT', label: '已提交' },
  { code: 'AUDITING', label: '审核中' },
  { code: 'CONTACT_CONFIRM', label: '待联系人确认' },
  { code: 'LEGAL_CONFIRM', label: '待法人确认' },
  { code: 'AUDIT_PASS', label: '审核通过' },
  { code: 'AUDIT_REJECT', label: '审核驳回' },
  { code: 'AUDIT_FREEZE', label: '已冻结' },
  { code: 'CANCELED', label: '已撤回' },
] as const

export const ALIPAY_APPLYMENT_STATE_LABEL: Record<string, string> = Object.fromEntries(
  ALIPAY_APPLYMENT_STATES.map((x) => [x.code, x.label]),
)

// ---------------------------------------------------------------------------
// 授权状态（authorizeState，微信/支付宝开户查询用）
// ---------------------------------------------------------------------------
export const AUTHORIZE_STATES = [
  { code: 'AUTHORIZE_STATE_UNAUTHORIZED', label: '未授权（微信）' },
  { code: 'AUTHORIZE_STATE_AUTHORIZED', label: '已授权（微信）' },
  { code: 'AUTHORIZED', label: '已确认（支付宝）' },
  { code: 'UNAUTHORIZED', label: '未确认（支付宝）' },
  { code: 'CLOSED', label: '已销户（支付宝）' },
  { code: 'SMID_NOT_EXIST', label: 'smid 不存在（支付宝）' },
] as const

export const AUTHORIZE_STATE_LABEL: Record<string, string> = Object.fromEntries(
  AUTHORIZE_STATES.map((x) => [x.code, x.label]),
)

// ---------------------------------------------------------------------------
// 报备渠道（registerChannel）
// ---------------------------------------------------------------------------
export const REGISTER_CHANNELS = [
  { code: 'UNIONPAY', label: '银联' },
  { code: 'NETUNION', label: '网联' },
  { code: 'UNIONPAY_NEIMENG', label: '内蒙银联' },
  { code: 'NETPURSE', label: '网联小钱包' },
  { code: 'CODEPAYIFS', label: '条码支付综合前置' },
  { code: 'ALIPAY_FLOWER', label: '支付宝健康分' },
  { code: 'ICBC', label: '工行' },
  { code: 'ABC', label: '农行' },
  { code: 'BCM', label: '交行' },
  { code: 'CCB', label: '建行' },
  { code: 'NUCC', label: '新网联' },
  { code: 'CMB', label: '招行' },
  { code: 'CIB', label: '兴业' },
] as const

export const REGISTER_CHANNEL_LABEL: Record<string, string> = Object.fromEntries(
  REGISTER_CHANNELS.map((x) => [x.code, x.label]),
)

// ---------------------------------------------------------------------------
// 报备类型（registerType）
// ---------------------------------------------------------------------------
export const REGISTER_TYPES = [
  { code: 'WXZF', label: '微信' },
  { code: 'ZFBZF', label: '支付宝' },
  { code: 'SNZF', label: '苏宁钱包' },
  { code: 'YZF', label: '翼支付' },
  { code: 'SZHB', label: '数字货币' },
  { code: 'NUCC', label: '互联互通' },
  { code: 'UNION', label: '银联二维码' },
] as const

export const REGISTER_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  REGISTER_TYPES.map((x) => [x.code, x.label]),
)

// ---------------------------------------------------------------------------
// 交易钱包类型（mrchAuthStateQuery.tradeMode）
// ---------------------------------------------------------------------------
export const TRADE_MODES = [
  { code: 'WECHAT', label: '微信' },
  { code: 'ALIPAY', label: '支付宝' },
] as const

export const TRADE_MODE_LABEL: Record<string, string> = Object.fromEntries(
  TRADE_MODES.map((x) => [x.code, x.label]),
)

// ---------------------------------------------------------------------------
// D1 地区码（凤御本地化常用，按 plan 文档要求硬编码湖南张家界一带）
// 完整字典需后续从拉卡拉 xlsx 导入。
// ---------------------------------------------------------------------------
export const DIST_CODES = [
  { code: '430000', label: '湖南省' },
  { code: '430800', label: '张家界市' },
  { code: '430802', label: '永定区' },
  { code: '430811', label: '武陵源区' },
  { code: '430821', label: '慈利县' },
  { code: '430822', label: '桑植县' },
] as const

export const DIST_CODE_LABEL: Record<string, string> = Object.fromEntries(
  DIST_CODES.map((x) => [x.code, x.label]),
)

// ---------------------------------------------------------------------------
// 日切时间（clearDt，默认 TWENTY_THREE）
// ---------------------------------------------------------------------------
export const CLEAR_DTS = [
  { code: 'TWENTY_THREE', label: '23:00（默认）' },
  { code: 'ZERO', label: '00:00' },
  { code: 'ONE', label: '01:00' },
] as const

export const CLEAR_DT_LABEL: Record<string, string> = Object.fromEntries(
  CLEAR_DTS.map((x) => [x.code, x.label]),
)
