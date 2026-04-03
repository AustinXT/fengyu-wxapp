/**
 * Seed script — 按 FK 顺序 INSERT 测试数据
 *
 * 用法: bun run db:seed
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { sql } from 'drizzle-orm'

// Schema tables
import { orgNodes, stores } from '@db/org'
import { clientWechatUsers, staffWechatUsers } from '@db/user'
import { productCategories, products, productSkus, mallCategories, mallProductSkus } from '@db/product'
import { saleOrders, saleItems, saleAllocations } from '@db/order'
import { appointments } from '@db/appointment'
import { serviceOrders, serviceItems } from '@db/service'
import { permissionRoles } from '@db/permission'
import { commissionRateMatrix } from '@db/commission'
import { couponTemplates } from '@db/coupon'
import { operationLogs } from '@db/operation-log'

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp'

const client = postgres(connectionString, { max: 1 })
const db = drizzle(client)

// ---------------------------------------------------------------------------
// Seed Data
// ---------------------------------------------------------------------------

// 注意：不插入 headquarters / market 节点，这些由 sync-workfine.js 同步创建。
// Seed 仅插入测试门店和部门节点，挂在 sync 创建的市场节点下。
// sync HQ: 16d1184b46db099a (总部)
// sync 南昌市场: 6707cc8b88579108 / sync 九江市场: dad2db0b1249daca
const ORG_NODES = [
  { id: 'org-store-nc01', name: '南昌旗舰店', type: '门店' as const, parentId: '6707cc8b88579108', sortOrder: 1, isActive: true },
  { id: 'org-store-nc02', name: '青山湖店', type: '门店' as const, parentId: '6707cc8b88579108', sortOrder: 2, isActive: true },
  { id: 'org-store-jj01', name: '九江旗舰店', type: '门店' as const, parentId: 'dad2db0b1249daca', sortOrder: 1, isActive: true },
  { id: 'org-store-gqc01', name: '共青城店', type: '门店' as const, parentId: 'dad2db0b1249daca', sortOrder: 2, isActive: true },
  { id: 'org-dept-nc01-beauty', name: '美容部', type: '部门' as const, parentId: 'org-store-nc01', sortOrder: 1, isActive: true },
  { id: 'org-dept-nc01-wellness', name: '养生部', type: '部门' as const, parentId: 'org-store-nc01', sortOrder: 2, isActive: true },
  { id: 'org-dept-nc01-promo', name: '推广部', type: '部门' as const, parentId: 'org-store-nc01', sortOrder: 3, isActive: true },
  { id: 'org-dept-nc02-beauty', name: '美容部', type: '部门' as const, parentId: 'org-store-nc02', sortOrder: 1, isActive: true },
  { id: 'org-dept-nc02-wellness', name: '养生部', type: '部门' as const, parentId: 'org-store-nc02', sortOrder: 2, isActive: true },
  { id: 'org-dept-nc02-promo', name: '推广部', type: '部门' as const, parentId: 'org-store-nc02', sortOrder: 3, isActive: true },
  { id: 'org-dept-jj01-beauty', name: '美容部', type: '部门' as const, parentId: 'org-store-jj01', sortOrder: 1, isActive: true },
  { id: 'org-dept-jj01-wellness', name: '养生部', type: '部门' as const, parentId: 'org-store-jj01', sortOrder: 2, isActive: true },
  { id: 'org-dept-jj01-promo', name: '推广部', type: '部门' as const, parentId: 'org-store-jj01', sortOrder: 3, isActive: true },
  { id: 'org-dept-gqc01-beauty', name: '美容部', type: '部门' as const, parentId: 'org-store-gqc01', sortOrder: 1, isActive: true },
  { id: 'org-dept-gqc01-wellness', name: '养生部', type: '部门' as const, parentId: 'org-store-gqc01', sortOrder: 2, isActive: true },
  { id: 'org-dept-gqc01-promo', name: '推广部', type: '部门' as const, parentId: 'org-store-gqc01', sortOrder: 3, isActive: true },
]

const STORES = [
  {
    storeId: 'store-nc01', storeName: '南昌旗舰店', orgNodeId: 'org-store-nc01',
    openingDate: '2025-01-15', bedCount: 12, isClosed: false,
    coverImage: 'cloud://store-covers/nc01.jpg',
    images: ['cloud://store-images/nc01-1.jpg', 'cloud://store-images/nc01-2.jpg'],
    district: '南昌市东湖区', streetAddress: '八一大道168号凤凰国际广场3层',
    latitude: '28.682892', longitude: '115.893528',
    phone: '0791-88881001', businessHours: '09:00-21:00',
    description: '凤御双美南昌旗舰店，集美容、养生、护肤于一体的高端美容会所。',
    announcement: '三月春季焕肤月，全场护理项目8.5折。',
    parkingInfo: '凤凰国际广场地下停车场B2层，凭消费小票免费停车3小时。',
  },
  {
    storeId: 'store-nc02', storeName: '青山湖店', orgNodeId: 'org-store-nc02',
    openingDate: '2025-03-01', bedCount: 8, isClosed: false,
    coverImage: 'cloud://store-covers/nc02.jpg',
    images: ['cloud://store-images/nc02-1.jpg'],
    district: '南昌市青山湖区', streetAddress: '北京东路889号万达广场2层',
    latitude: '28.695123', longitude: '115.948765',
    phone: '0791-88881002', businessHours: '09:30-21:00',
    description: '凤御双美青山湖店，社区级美容养生馆。',
    announcement: null,
    parkingInfo: '万达广场地下停车场，消费满200元免费停车2小时。',
  },
  {
    storeId: 'store-jj01', storeName: '九江旗舰店', orgNodeId: 'org-store-jj01',
    openingDate: '2025-02-01', bedCount: 10, isClosed: false,
    coverImage: 'cloud://store-covers/jj01.jpg',
    images: ['cloud://store-images/jj01-1.jpg', 'cloud://store-images/jj01-2.jpg'],
    district: '九江市浔阳区', streetAddress: '浔阳路99号联盛广场5层',
    latitude: '29.705610', longitude: '116.001522',
    phone: '0792-88882001', businessHours: '09:00-21:00',
    description: '凤御双美九江旗舰店，九江市高端美容养生首选。',
    announcement: '新店开业，首次到店体验免费面部护理一次。',
    parkingInfo: '联盛广场停车场，消费免费停车。',
  },
  {
    storeId: 'store-gqc01', storeName: '共青城店', orgNodeId: 'org-store-gqc01',
    openingDate: '2025-06-01', bedCount: 6, isClosed: false,
    coverImage: 'cloud://store-covers/gqc01.jpg',
    images: null,
    district: '共青城市', streetAddress: '共青大道66号创业中心2层',
    latitude: '29.238800', longitude: '115.808900',
    phone: '0792-88882002', businessHours: '09:30-20:30',
    description: '凤御双美共青城店，小而精致的美容养生馆。',
    announcement: null,
    parkingInfo: '创业中心免费停车。',
  },
]

const STAFF = [
  { employeeId: 'FY-260101-0001', openid: 'o_staff_zhangming', phone: '13800138000', name: '张明', gender: '男', idCard: '3601**********0011', storeId: 'store-nc01', orgNodeId: 'org-dept-nc01-beauty', positionName: '店长', birthday: '1988-05-12', skills: ['管理', '美容师'], isResigned: false },
  { employeeId: 'FY-260101-0002', openid: 'o_staff_liufang', phone: '13800138001', name: '刘芳', gender: '女', idCard: '3601**********0028', storeId: 'store-nc01', orgNodeId: 'org-dept-nc01-beauty', positionName: '高级美容师', birthday: '1992-08-23', skills: ['美容师', '面部护理', '身体护理'], isResigned: false },
  { employeeId: 'FY-260101-0003', openid: 'o_staff_wangjing', phone: '13800138002', name: '王静', gender: '女', idCard: '3601**********0035', storeId: 'store-nc01', orgNodeId: 'org-dept-nc01-wellness', positionName: '养生师', birthday: '1990-11-07', skills: ['养生师', '经络调理', '艾灸'], isResigned: false },
  { employeeId: 'FY-260101-0004', openid: 'o_staff_chenwei', phone: '13800138003', name: '陈伟', gender: '男', idCard: '3601**********0042', storeId: 'store-nc01', orgNodeId: 'org-dept-nc01-promo', positionName: '推广顾问', birthday: '1995-03-15', skills: ['推广师'], isResigned: false },
  { employeeId: 'FY-260301-0005', openid: 'o_staff_zhaoling', phone: '13800138004', name: '赵玲', gender: '女', idCard: '3601**********0059', storeId: 'store-nc02', orgNodeId: 'org-dept-nc02-beauty', positionName: '店长', birthday: '1989-07-20', skills: ['管理', '美容师'], isResigned: false },
  { employeeId: 'FY-260201-0006', openid: 'o_staff_sunhao', phone: '13800138005', name: '孙浩', gender: '男', idCard: '3602**********0066', storeId: 'store-jj01', orgNodeId: 'org-dept-jj01-beauty', positionName: '店长', birthday: '1987-12-03', skills: ['管理', '美容师'], isResigned: false },
  { employeeId: 'FY-260201-0007', openid: 'o_staff_zhouxia', phone: '13800138006', name: '周霞', gender: '女', idCard: '3602**********0073', storeId: 'store-jj01', orgNodeId: 'org-dept-jj01-beauty', positionName: '美容师', birthday: '1993-04-18', skills: ['美容师', '面部护理'], isResigned: false },
  { employeeId: 'FY-260601-0008', openid: 'o_staff_huangmin', phone: '13800138007', name: '黄敏', gender: '女', idCard: '3602**********0080', storeId: 'store-gqc01', orgNodeId: 'org-dept-gqc01-beauty', positionName: '店长', birthday: '1991-09-28', skills: ['管理', '美容师', '养生师'], isResigned: false },
  { employeeId: 'FY-260101-0009', openid: 'o_staff_wuyan', phone: '13800138008', name: '吴燕', gender: '女', idCard: '3601**********0097', storeId: 'store-nc01', orgNodeId: 'org-dept-nc01-beauty', positionName: '美容师', birthday: '1996-01-10', skills: ['美容师', '面部护理', '皮肤管理'], isResigned: false },
  { employeeId: 'FY-260101-0010', openid: null, phone: '13800138009', name: '郑强', gender: '男', idCard: '3601**********0104', storeId: 'store-nc02', orgNodeId: 'org-dept-nc02-promo', positionName: '推广顾问', birthday: '1994-06-25', skills: ['推广师'], isResigned: true },
]

const CLIENTS = [
  { userId: 'FYGK-20250120-0001', openid: 'o_client_linmei', phone: '13900139001', customerId: 'WF-C-0001', name: '林美', boundStoreId: 'store-nc01', boundEmployeeId: 'FY-260101-0002', memberLevel: '黑钻' as const, customerSource: '老带新' as const, birthday: '1985-06-18', occupation: '企业高管', isMarried: true, wechatName: '美美林', skinType: '干性', improvementFocus: '抗衰老、提拉紧致', skinIssue: '法令纹较深', wellnessPreference: '经络调理' },
  { userId: 'FYGK-20250205-0002', openid: 'o_client_yangxue', phone: '13900139002', customerId: 'WF-C-0002', name: '杨雪', boundStoreId: 'store-nc01', boundEmployeeId: 'FY-260101-0009', memberLevel: '金钻' as const, customerSource: '美团' as const, birthday: '1990-12-05', occupation: '教师', isMarried: true, wechatName: '雪儿', skinType: '混合性', improvementFocus: '美白、祛斑', skinIssue: '色斑', wellnessPreference: null },
  { userId: 'FYGK-20250310-0003', openid: 'o_client_heli', phone: '13900139003', customerId: 'WF-C-0003', name: '何丽', boundStoreId: 'store-nc02', boundEmployeeId: 'FY-260301-0005', memberLevel: '星钻' as const, customerSource: '自进店' as const, birthday: '1993-03-22', occupation: '会计', isMarried: false, wechatName: '丽丽', skinType: '油性', improvementFocus: '控油、收缩毛孔', skinIssue: '毛孔粗大', wellnessPreference: null },
  { userId: 'FYGK-20250415-0004', openid: 'o_client_xuming', phone: '13900139004', customerId: 'WF-C-0004', name: '徐敏', boundStoreId: 'store-jj01', boundEmployeeId: 'FY-260201-0007', memberLevel: '金钻' as const, customerSource: '老带新' as const, birthday: '1988-09-14', occupation: '自由职业', isMarried: true, wechatName: '小敏', skinType: '敏感性', improvementFocus: '修复、舒敏', skinIssue: '泛红敏感', wellnessPreference: '艾灸' },
  { userId: 'FYGK-20250620-0005', openid: 'o_client_songqian', phone: '13900139005', customerId: 'WF-C-0005', name: '宋茜', boundStoreId: 'store-gqc01', boundEmployeeId: 'FY-260601-0008', memberLevel: '星钻' as const, customerSource: '抖音' as const, birthday: '1995-11-30', occupation: '设计师', isMarried: false, wechatName: '茜茜', skinType: '中性', improvementFocus: '日常保养', skinIssue: null, wellnessPreference: null },
  { userId: 'FYGK-20260101-0006', openid: 'o_client_zhanghua', phone: '13900139006', customerId: null, name: '张华', boundStoreId: 'store-nc01', boundEmployeeId: 'FY-260101-0002', memberLevel: '初钻' as const, customerSource: '自进店' as const, birthday: '1998-07-08', occupation: '学生', isMarried: false, wechatName: '华华', skinType: '油性', improvementFocus: '祛痘', skinIssue: '痘痘肌', wellnessPreference: null },
  { userId: 'FYGK-20260215-0007', openid: null, phone: '13900139007', customerId: 'WF-C-0007', name: '吕秀', boundStoreId: 'store-jj01', boundEmployeeId: 'FY-260201-0006', memberLevel: '黑钻' as const, customerSource: '推带新' as const, birthday: '1982-04-01', occupation: '企业主', isMarried: true, wechatName: null, skinType: '干性', improvementFocus: '抗衰老、紧致', skinIssue: '松弛下垂', wellnessPreference: '养生SPA' },
  { userId: 'FYGK-20260310-0008', openid: 'o_client_pengyu', phone: '13900139008', customerId: null, name: '彭玉', boundStoreId: 'store-nc02', boundEmployeeId: 'FY-260301-0005', memberLevel: '初钻' as const, customerSource: '小程序' as const, birthday: '1997-10-22', occupation: '护士', isMarried: false, wechatName: '小彭', skinType: '混合性', improvementFocus: '补水保湿', skinIssue: '季节性干燥', wellnessPreference: null },
]

// 一级分类（品项类型）：product_kind = null
const PRODUCT_KINDS = [
  { categoryId: 'kind-welfare', categoryName: '福利活动', productKind: null, sortOrder: 1, isValid: true },
  { categoryId: 'kind-care', categoryName: '护理项目', productKind: null, sortOrder: 2, isValid: true },
  { categoryId: 'kind-home', categoryName: '家居产品', productKind: null, sortOrder: 3, isValid: true },
  { categoryId: 'kind-card', categoryName: '充值卡', productKind: null, sortOrder: 4, isValid: true },
]

// 二级分类：product_kind = 所属一级分类的 categoryName
const PRODUCT_CATEGORIES = [
  { categoryId: 'cat-hl-01', categoryName: '新客体验', productKind: '福利活动', salesCategory: '自采自销' as const, sortOrder: 1, isValid: true },
  { categoryId: 'cat-hl-02', categoryName: '季节活动', productKind: '福利活动', salesCategory: '自采自销' as const, sortOrder: 2, isValid: true },
  { categoryId: 'cat-hl-03', categoryName: '周年庆', productKind: '福利活动', salesCategory: '自采自销' as const, sortOrder: 3, isValid: true },
  { categoryId: 'cat-hr-01', categoryName: '面部护理', productKind: '护理项目', salesCategory: '自采自销' as const, sortOrder: 1, isValid: true },
  { categoryId: 'cat-hr-02', categoryName: '身体护理', productKind: '护理项目', salesCategory: '自采自销' as const, sortOrder: 2, isValid: true },
  { categoryId: 'cat-hr-03', categoryName: '特色项目', productKind: '护理项目', salesCategory: '自采自销' as const, sortOrder: 3, isValid: true },
  { categoryId: 'cat-jj-01', categoryName: '护肤品', productKind: '家居产品', salesCategory: '自采自销' as const, sortOrder: 1, isValid: true },
  { categoryId: 'cat-jj-02', categoryName: '养生产品', productKind: '家居产品', salesCategory: '他销自耗' as const, sortOrder: 2, isValid: true },
  { categoryId: 'cat-cz-01', categoryName: '储值卡', productKind: '充值卡', salesCategory: '自采自销' as const, sortOrder: 1, isValid: true },
  { categoryId: 'cat-cz-02', categoryName: '次卡', productKind: '充值卡', salesCategory: '自采自销' as const, sortOrder: 2, isValid: true },
]

// 一级分组（category_group = null，Tab/分组头，不直接关联商品）
// 二级分类（category_group = 对应一级分组的 categoryName，商品挂载到此层）
const MALL_CATEGORIES = [
  // 一级分组
  { categoryId: 'mall-group-care', categoryName: '护理项目', sortOrder: 1 },
  { categoryId: 'mall-group-welfare', categoryName: '福利活动', sortOrder: 2 },
  { categoryId: 'mall-group-home', categoryName: '家居产品', sortOrder: 3 },
  { categoryId: 'mall-group-card', categoryName: '充值卡', sortOrder: 4 },
  // 二级分类 — 护理项目
  { categoryId: 'mall-cat-hr-01', categoryName: '面部护理', categoryGroup: '护理项目', sortOrder: 1 },
  { categoryId: 'mall-cat-hr-02', categoryName: '身体护理', categoryGroup: '护理项目', sortOrder: 2 },
  { categoryId: 'mall-cat-hr-03', categoryName: '特色项目', categoryGroup: '护理项目', sortOrder: 3 },
  // 二级分类 — 福利活动
  { categoryId: 'mall-cat-hl-01', categoryName: '新客体验', categoryGroup: '福利活动', sortOrder: 1 },
  { categoryId: 'mall-cat-hl-02', categoryName: '季节活动', categoryGroup: '福利活动', sortOrder: 2 },
  { categoryId: 'mall-cat-hl-03', categoryName: '周年庆', categoryGroup: '福利活动', sortOrder: 3 },
  // 二级分类 — 家居产品
  { categoryId: 'mall-cat-jj-01', categoryName: '护肤品', categoryGroup: '家居产品', sortOrder: 1 },
  { categoryId: 'mall-cat-jj-02', categoryName: '养生产品', categoryGroup: '家居产品', sortOrder: 2 },
  // 二级分类 — 充值卡
  { categoryId: 'mall-cat-cz-01', categoryName: '储值卡', categoryGroup: '充值卡', sortOrder: 1 },
  { categoryId: 'mall-cat-cz-02', categoryName: '次卡', categoryGroup: '充值卡', sortOrder: 2 },
]

const PRODUCTS = [
  { productId: 'prod-001', categoryId: 'mall-cat-hr-01', name: '蜜语水润嫩肤护理', coverImage: 'cloud://product-covers/prod-001.jpg', detailImages: ['cloud://product-details/prod-001-1.jpg', 'cloud://product-details/prod-001-2.jpg'], description: '深层补水+嫩肤修复，改善干燥粗糙肌肤，恢复水润光泽。', isBundle: false, price: '299.00', specialPrice: '259.00', manageScope: null, marketScope: null, sortOrder: 1, isEnabled: true, isVisible: true },
  { productId: 'prod-002', categoryId: 'mall-cat-hr-01', name: '科颜美逆龄焕肤', coverImage: 'cloud://product-covers/prod-002.jpg', detailImages: ['cloud://product-details/prod-002-1.jpg'], description: '采用进口科颜美精华，深层修复肌肤屏障，抗衰紧致。', isBundle: false, price: '599.00', specialPrice: '499.00', manageScope: null, marketScope: null, sortOrder: 2, isEnabled: true, isVisible: true },
  { productId: 'prod-003', categoryId: 'mall-cat-hr-02', name: '经络疏通养生护理', coverImage: 'cloud://product-covers/prod-003.jpg', detailImages: null, description: '中医经络手法，疏通全身气血，缓解疲劳酸痛。', isBundle: false, price: '388.00', specialPrice: null, manageScope: null, marketScope: null, sortOrder: 1, isEnabled: true, isVisible: true },
  { productId: 'prod-004', categoryId: 'mall-cat-hl-01', name: '新客首次体验套餐', coverImage: 'cloud://product-covers/prod-004.jpg', detailImages: null, description: '首次到店顾客专享，面部深层清洁+基础护理+肩颈放松。', isBundle: true, price: '99.00', specialPrice: null, manageScope: null, marketScope: null, sortOrder: 1, isEnabled: true, isVisible: true },
  { productId: 'prod-005', categoryId: 'mall-cat-jj-01', name: '凤御玻尿酸精华液', coverImage: 'cloud://product-covers/prod-005.jpg', detailImages: ['cloud://product-details/prod-005-1.jpg'], description: '高浓度玻尿酸精华，深层补水锁水，改善肌肤干燥。', isBundle: false, price: '268.00', specialPrice: '228.00', manageScope: null, marketScope: null, sortOrder: 1, isEnabled: true, isVisible: true },
  { productId: 'prod-006', categoryId: 'mall-cat-jj-02', name: '艾草精油礼盒', coverImage: 'cloud://product-covers/prod-006.jpg', detailImages: null, description: '天然艾草精油套装，适合家庭养生艾灸使用。', isBundle: false, price: '198.00', specialPrice: '168.00', manageScope: null, marketScope: null, sortOrder: 1, isEnabled: true, isVisible: true },
  { productId: 'prod-007', categoryId: 'mall-cat-cz-01', name: '金卡充值卡', coverImage: 'cloud://product-covers/prod-007.jpg', detailImages: null, description: '充值5000元享金卡会员权益，全场项目9折优惠。', isBundle: false, price: '5000.00', specialPrice: null, manageScope: null, marketScope: null, sortOrder: 1, isEnabled: true, isVisible: true },
  { productId: 'prod-008', categoryId: 'mall-cat-hr-03', name: '光子嫩肤仪器护理', coverImage: 'cloud://product-covers/prod-008.jpg', detailImages: ['cloud://product-details/prod-008-1.jpg'], description: '先进光子嫩肤仪器，改善色素沉着、毛孔粗大、细纹等肌肤问题。', isBundle: false, price: '880.00', specialPrice: '780.00', manageScope: null, marketScope: null, sortOrder: 1, isEnabled: true, isVisible: true },
]

const PRODUCT_SKUS = [
  { skuId: 'sku-001-01', categoryId: 'cat-hr-01', productType: '单品' as const, specName: '蜜语水润嫩肤护理 单次体验', price: '299.00', specialPrice: '259.00', sessionCount: 1, sortOrder: 1, serviceFee: '30.00', isShengmei: true, marketScope: null, isEnabled: true },
  { skuId: 'sku-001-02', categoryId: 'cat-hr-01', productType: '疗程卡' as const, specName: '蜜语水润嫩肤护理 10次卡', price: '1999.00', specialPrice: '1800.00', sessionCount: 10, sortOrder: 2, serviceFee: '50.00', isShengmei: true, marketScope: null, isEnabled: true },
  { skuId: 'sku-001-03', categoryId: 'cat-hr-01', productType: '疗程卡' as const, specName: '蜜语水润嫩肤护理 20次卡', price: '3599.00', specialPrice: '3200.00', sessionCount: 20, sortOrder: 3, serviceFee: '50.00', isShengmei: true, marketScope: null, isEnabled: true },
  { skuId: 'sku-002-01', categoryId: 'cat-hr-01', productType: '单品' as const, specName: '科颜美逆龄焕肤 单次', price: '599.00', specialPrice: '499.00', sessionCount: 1, sortOrder: 1, serviceFee: '50.00', isShengmei: true, marketScope: null, isEnabled: true },
  { skuId: 'sku-002-02', categoryId: 'cat-hr-01', productType: '疗程卡' as const, specName: '科颜美逆龄焕肤 6次卡', price: '2999.00', specialPrice: '2680.00', sessionCount: 6, sortOrder: 2, serviceFee: '60.00', isShengmei: true, marketScope: null, isEnabled: true },
  { skuId: 'sku-003-01', categoryId: 'cat-hr-02', productType: '单品' as const, specName: '经络疏通养生护理 60分钟', price: '388.00', specialPrice: null, sessionCount: 1, sortOrder: 1, serviceFee: '40.00', isShengmei: false, marketScope: null, isEnabled: true },
  { skuId: 'sku-003-02', categoryId: 'cat-hr-02', productType: '疗程卡' as const, specName: '经络疏通养生护理 10次卡', price: '2880.00', specialPrice: '2580.00', sessionCount: 10, sortOrder: 2, serviceFee: '40.00', isShengmei: false, marketScope: null, isEnabled: true },
  { skuId: 'sku-004-01', categoryId: 'cat-hl-01', productType: '单品' as const, specName: '新客体验 面部深层清洁', price: '0.00', specialPrice: null, sessionCount: 1, sortOrder: 1, serviceFee: '20.00', isShengmei: null, marketScope: null, isEnabled: true },
  { skuId: 'sku-004-02', categoryId: 'cat-hl-01', productType: '单品' as const, specName: '新客体验 基础面部护理', price: '0.00', specialPrice: null, sessionCount: 1, sortOrder: 2, serviceFee: '20.00', isShengmei: null, marketScope: null, isEnabled: true },
  { skuId: 'sku-004-03', categoryId: 'cat-hl-01', productType: '单品' as const, specName: '新客体验 肩颈放松', price: '0.00', specialPrice: null, sessionCount: 1, sortOrder: 3, serviceFee: '15.00', isShengmei: null, marketScope: null, isEnabled: true },
  { skuId: 'sku-005-01', categoryId: 'cat-jj-01', productType: '单品' as const, specName: '凤御玻尿酸精华液 30ml', price: '268.00', specialPrice: '228.00', sessionCount: null, sortOrder: 1, serviceFee: '0', isShengmei: null, marketScope: null, isEnabled: true },
  { skuId: 'sku-005-02', categoryId: 'cat-jj-01', productType: '单品' as const, specName: '凤御玻尿酸精华液 60ml', price: '468.00', specialPrice: '398.00', sessionCount: null, sortOrder: 2, serviceFee: '0', isShengmei: null, marketScope: null, isEnabled: true },
  { skuId: 'sku-006-01', categoryId: 'cat-jj-02', productType: '单品' as const, specName: '艾草精油礼盒 标准礼盒', price: '198.00', specialPrice: '168.00', sessionCount: null, sortOrder: 1, serviceFee: '0', isShengmei: null, marketScope: null, isEnabled: true },
  { skuId: 'sku-007-01', categoryId: 'cat-cz-01', productType: '单品' as const, specName: '金卡充值卡 5000', price: '5000.00', specialPrice: null, sessionCount: null, sortOrder: 1, serviceFee: '0', isShengmei: null, marketScope: null, isEnabled: true },
  { skuId: 'sku-008-01', categoryId: 'cat-hr-03', productType: '单品' as const, specName: '光子嫩肤仪器护理 单次', price: '880.00', specialPrice: '780.00', sessionCount: 1, sortOrder: 1, serviceFee: '80.00', isShengmei: true, marketScope: null, isEnabled: true },
  { skuId: 'sku-008-02', categoryId: 'cat-hr-03', productType: '疗程卡' as const, specName: '光子嫩肤仪器护理 5次卡', price: '3880.00', specialPrice: '3500.00', sessionCount: 5, sortOrder: 2, serviceFee: '80.00', isShengmei: true, marketScope: null, isEnabled: true },
]

const MALL_PRODUCT_SKUS = [
  { productId: 'prod-001', skuId: 'sku-001-01', bundlePrice: null, sortOrder: 1 },
  { productId: 'prod-001', skuId: 'sku-001-02', bundlePrice: null, sortOrder: 2 },
  { productId: 'prod-001', skuId: 'sku-001-03', bundlePrice: null, sortOrder: 3 },
  { productId: 'prod-002', skuId: 'sku-002-01', bundlePrice: null, sortOrder: 1 },
  { productId: 'prod-002', skuId: 'sku-002-02', bundlePrice: null, sortOrder: 2 },
  { productId: 'prod-003', skuId: 'sku-003-01', bundlePrice: null, sortOrder: 1 },
  { productId: 'prod-003', skuId: 'sku-003-02', bundlePrice: null, sortOrder: 2 },
  { productId: 'prod-004', skuId: 'sku-004-01', bundlePrice: null, sortOrder: 1 },
  { productId: 'prod-004', skuId: 'sku-004-02', bundlePrice: null, sortOrder: 2 },
  { productId: 'prod-004', skuId: 'sku-004-03', bundlePrice: null, sortOrder: 3 },
  { productId: 'prod-005', skuId: 'sku-005-01', bundlePrice: null, sortOrder: 1 },
  { productId: 'prod-005', skuId: 'sku-005-02', bundlePrice: null, sortOrder: 2 },
  { productId: 'prod-006', skuId: 'sku-006-01', bundlePrice: null, sortOrder: 1 },
  { productId: 'prod-007', skuId: 'sku-007-01', bundlePrice: null, sortOrder: 1 },
  { productId: 'prod-008', skuId: 'sku-008-01', bundlePrice: null, sortOrder: 1 },
  { productId: 'prod-008', skuId: 'sku-008-02', bundlePrice: null, sortOrder: 2 },
]

const SALE_ORDERS = [
  { saleOrderId: 'FY-XSD-WX-260310-0001', status: '已支付' as const, saleOrderType: '普通' as const, refSaleOrderId: null, marketName: '南昌市场', storeId: 'store-nc01', saleOrderDatetime: new Date('2026-03-10T10:30:00Z'), clientUserId: 'FYGK-20250120-0001', clientPhone: '13900139001', customerName: '林美', totalAmount: '2299.00', paymentMethod: '微信' as const, openedBy: 'FY-260101-0001', preferredEmployeeId: 'FY-260101-0002', paidAt: new Date('2026-03-10T10:35:00Z'), allocationStatus: '已分配' as const, couponId: null, couponDiscount: '0' },
  { saleOrderId: 'FY-XSD-WX-260311-0002', status: '已支付' as const, saleOrderType: '普通' as const, refSaleOrderId: null, marketName: '九江市场', storeId: 'store-jj01', saleOrderDatetime: new Date('2026-03-11T14:00:00Z'), clientUserId: 'FYGK-20250415-0004', clientPhone: '13900139004', customerName: '徐敏', totalAmount: '2580.00', paymentMethod: '线下' as const, openedBy: 'FY-260201-0006', preferredEmployeeId: 'FY-260201-0007', paidAt: new Date('2026-03-11T14:10:00Z'), allocationStatus: '待分配' as const, couponId: null, couponDiscount: '0' },
  { saleOrderId: 'FY-XSD-WX-260312-0003', status: '待确认收款' as const, saleOrderType: '体验' as const, refSaleOrderId: null, marketName: '南昌市场', storeId: 'store-nc02', saleOrderDatetime: new Date('2026-03-12T09:00:00Z'), clientUserId: 'FYGK-20260310-0008', clientPhone: '13900139008', customerName: '彭玉', totalAmount: '99.00', paymentMethod: '线下' as const, openedBy: 'FY-260301-0005', preferredEmployeeId: 'FY-260301-0005', paidAt: null, allocationStatus: null, couponId: null, couponDiscount: '0' },
  { saleOrderId: 'FY-XSD-WX-260312-0004', status: '已支付' as const, saleOrderType: '普通' as const, refSaleOrderId: null, marketName: '南昌市场', storeId: 'store-nc01', saleOrderDatetime: new Date('2026-03-12T15:00:00Z'), clientUserId: 'FYGK-20250205-0002', clientPhone: '13900139002', customerName: '杨雪', totalAmount: '3500.00', paymentMethod: '微信' as const, openedBy: null, preferredEmployeeId: 'FY-260101-0009', paidAt: new Date('2026-03-12T15:05:00Z'), allocationStatus: '待分配' as const, couponId: null, couponDiscount: '0' },
  { saleOrderId: 'FY-XSD-WX-260313-0005', status: '待支付' as const, saleOrderType: '普通' as const, refSaleOrderId: null, marketName: '九江市场', storeId: 'store-gqc01', saleOrderDatetime: new Date('2026-03-13T10:00:00Z'), clientUserId: 'FYGK-20250620-0005', clientPhone: '13900139005', customerName: '宋茜', totalAmount: '456.00', paymentMethod: '微信' as const, openedBy: 'FY-260601-0008', preferredEmployeeId: 'FY-260601-0008', paidAt: null, allocationStatus: null, couponId: null, couponDiscount: '0' },
  { saleOrderId: 'FY-XSD-WX-260313-0006', status: '已关闭' as const, saleOrderType: '普通' as const, refSaleOrderId: null, marketName: '南昌市场', storeId: 'store-nc01', saleOrderDatetime: new Date('2026-03-13T11:00:00Z'), clientUserId: 'FYGK-20260101-0006', clientPhone: '13900139006', customerName: '张华', totalAmount: '259.00', paymentMethod: '微信' as const, openedBy: 'FY-260101-0001', preferredEmployeeId: 'FY-260101-0002', paidAt: null, allocationStatus: null, couponId: null, couponDiscount: '0' },
]

const SALE_ITEMS = [
  { saleItemId: 'XSLSH-WX-202603100001', saleOrderId: 'FY-XSD-WX-260310-0001', itemDirection: '购买' as const, refSaleItemId: null, skuId: 'sku-001-02', productName: '蜜语水润嫩肤护理', skuSpecName: '10次卡', productType: '疗程卡' as const, sessionCount: 10, remainingSessions: 8, unitPrice: '1999.00', quantity: 1, unitRealPrice: '1800.00', saleAmount: '1800.00', received: '1800.00', expireDate: '2027-03-10', remark: null, salesCategory: '自采自销' as const },
  { saleItemId: 'XSLSH-WX-202603100002', saleOrderId: 'FY-XSD-WX-260310-0001', itemDirection: '购买' as const, refSaleItemId: null, skuId: 'sku-002-01', productName: '科颜美逆龄焕肤', skuSpecName: '单次', productType: '单品' as const, sessionCount: 1, remainingSessions: 0, unitPrice: '599.00', quantity: 1, unitRealPrice: '499.00', saleAmount: '499.00', received: '499.00', expireDate: null, remark: null, salesCategory: '自采自销' as const },
  { saleItemId: 'XSLSH-WX-202603110001', saleOrderId: 'FY-XSD-WX-260311-0002', itemDirection: '购买' as const, refSaleItemId: null, skuId: 'sku-003-02', productName: '经络疏通养生护理', skuSpecName: '10次卡', productType: '疗程卡' as const, sessionCount: 10, remainingSessions: 10, unitPrice: '2880.00', quantity: 1, unitRealPrice: '2580.00', saleAmount: '2580.00', received: '2580.00', expireDate: '2027-03-11', remark: null, salesCategory: '自采自销' as const },
  { saleItemId: 'XSLSH-WX-202603120001', saleOrderId: 'FY-XSD-WX-260312-0003', itemDirection: '购买' as const, refSaleItemId: null, skuId: 'sku-004-01', productName: '新客首次体验套餐', skuSpecName: '面部深层清洁', productType: '单品' as const, sessionCount: 1, remainingSessions: 1, unitPrice: '99.00', quantity: 1, unitRealPrice: '99.00', saleAmount: '99.00', received: '99.00', expireDate: '2026-12-31', remark: '新客体验', salesCategory: '自采自销' as const },
  { saleItemId: 'XSLSH-WX-202603120002', saleOrderId: 'FY-XSD-WX-260312-0004', itemDirection: '购买' as const, refSaleItemId: null, skuId: 'sku-008-02', productName: '光子嫩肤仪器护理', skuSpecName: '5次卡', productType: '疗程卡' as const, sessionCount: 5, remainingSessions: 5, unitPrice: '3880.00', quantity: 1, unitRealPrice: '3500.00', saleAmount: '3500.00', received: '3500.00', expireDate: '2027-03-12', remark: null, salesCategory: '自采自销' as const },
  { saleItemId: 'XSLSH-WX-202603130001', saleOrderId: 'FY-XSD-WX-260313-0005', itemDirection: '购买' as const, refSaleItemId: null, skuId: 'sku-005-01', productName: '凤御玻尿酸精华液', skuSpecName: '30ml', productType: '单品' as const, sessionCount: null, remainingSessions: null, unitPrice: '268.00', quantity: 2, unitRealPrice: '228.00', saleAmount: '456.00', received: '456.00', expireDate: null, remark: null, salesCategory: '自采自销' as const },
  { saleItemId: 'XSLSH-WX-202603130002', saleOrderId: 'FY-XSD-WX-260313-0006', itemDirection: '购买' as const, refSaleItemId: null, skuId: 'sku-001-01', productName: '蜜语水润嫩肤护理', skuSpecName: '单次体验', productType: '单品' as const, sessionCount: 1, remainingSessions: 1, unitPrice: '299.00', quantity: 1, unitRealPrice: '259.00', saleAmount: '259.00', received: '259.00', expireDate: null, remark: null, salesCategory: '自采自销' as const },
]

const SALE_ALLOCATIONS = [
  { saleItemId: 'XSLSH-WX-202603100001', employeeId: 'FY-260101-0002', allocationRatio: '0.80', totalAmount: '1440.00', isVoid: false },
  { saleItemId: 'XSLSH-WX-202603100001', employeeId: 'FY-260101-0004', allocationRatio: '0.20', totalAmount: '360.00', isVoid: false },
  { saleItemId: 'XSLSH-WX-202603100002', employeeId: 'FY-260101-0002', allocationRatio: '1.00', totalAmount: '499.00', isVoid: false },
]

const APPOINTMENTS = [
  { appointmentId: 'appt-001', status: '已完成' as const, storeId: 'store-nc01', clientUserId: 'FYGK-20250120-0001', clientName: '林美', employeeId: 'FY-260101-0002', employeeName: '刘芳', saleItemId: 'XSLSH-WX-202603100001', appointmentTime: new Date('2026-03-11T10:00:00Z'), checkinAt: new Date('2026-03-11T09:55:00Z'), notes: '蜜语嫩肤第1次' },
  { appointmentId: 'appt-002', status: '已完成' as const, storeId: 'store-nc01', clientUserId: 'FYGK-20250120-0001', clientName: '林美', employeeId: 'FY-260101-0002', employeeName: '刘芳', saleItemId: 'XSLSH-WX-202603100001', appointmentTime: new Date('2026-03-12T14:00:00Z'), checkinAt: new Date('2026-03-12T13:50:00Z'), notes: '蜜语嫩肤第2次' },
  { appointmentId: 'appt-003', status: '待确认' as const, storeId: 'store-nc01', clientUserId: 'FYGK-20250205-0002', clientName: '杨雪', employeeId: 'FY-260101-0009', employeeName: '吴燕', saleItemId: 'XSLSH-WX-202603120002', appointmentTime: new Date('2026-03-14T10:00:00Z'), checkinAt: null, notes: '光子嫩肤第1次' },
  { appointmentId: 'appt-004', status: '已确认' as const, storeId: 'store-jj01', clientUserId: 'FYGK-20250415-0004', clientName: '徐敏', employeeId: 'FY-260201-0007', employeeName: '周霞', saleItemId: 'XSLSH-WX-202603110001', appointmentTime: new Date('2026-03-13T14:00:00Z'), checkinAt: null, notes: '经络疏通第1次' },
  { appointmentId: 'appt-005', status: '已取消' as const, storeId: 'store-gqc01', clientUserId: 'FYGK-20250620-0005', clientName: '宋茜', employeeId: 'FY-260601-0008', employeeName: '黄敏', saleItemId: null, appointmentTime: new Date('2026-03-12T15:00:00Z'), checkinAt: null, notes: '临时有事取消' },
]

const SERVICE_ORDERS = [
  { serviceOrderId: 'HLD-WX-2603110001', status: '已完成' as const, serviceOrderType: '售后' as const, marketName: '南昌市场', storeId: 'store-nc01', serviceDate: '2026-03-11', assignedEmployeeId: 'FY-260101-0002', remark: null, appointmentId: 'appt-001', clientUserId: 'FYGK-20250120-0001' },
  { serviceOrderId: 'HLD-WX-2603120001', status: '已完成' as const, serviceOrderType: '售后' as const, marketName: '南昌市场', storeId: 'store-nc01', serviceDate: '2026-03-12', assignedEmployeeId: 'FY-260101-0002', remark: null, appointmentId: 'appt-002', clientUserId: 'FYGK-20250120-0001' },
  { serviceOrderId: 'HLD-WX-2603130001', status: '待服务' as const, serviceOrderType: '售前' as const, marketName: '九江市场', storeId: 'store-jj01', serviceDate: '2026-03-13', assignedEmployeeId: 'FY-260201-0007', remark: '顾客要求使用温和型产品', appointmentId: 'appt-004', clientUserId: 'FYGK-20250415-0004' },
  { serviceOrderId: 'HLD-WX-2603130002', status: '服务中' as const, serviceOrderType: '售前' as const, marketName: '南昌市场', storeId: 'store-nc01', serviceDate: '2026-03-13', assignedEmployeeId: 'FY-260101-0009', remark: null, appointmentId: null, clientUserId: 'FYGK-20250205-0002' },
]

const SERVICE_ITEMS = [
  { serviceItemId: 'svc-item-001', serviceOrderId: 'HLD-WX-2603110001', saleItemId: 'XSLSH-WX-202603100001', sessionUsed: 1, employeeId: 'FY-260101-0002', serviceDuration: 90, unitRealPrice: '1800.00' },
  { serviceItemId: 'svc-item-002', serviceOrderId: 'HLD-WX-2603120001', saleItemId: 'XSLSH-WX-202603100001', sessionUsed: 1, employeeId: 'FY-260101-0002', serviceDuration: 90, unitRealPrice: '1800.00' },
]

const PERMISSION_ROLES = [
  { employeeId: 'FY-260101-0001', role: 'admin', scopeId: '16d1184b46db099a', createdBy: 'system' },
  { employeeId: 'FY-260101-0001', role: 'manager', scopeId: 'org-store-nc01', createdBy: 'sync' },
  { employeeId: 'FY-260301-0005', role: 'manager', scopeId: 'org-store-nc02', createdBy: 'sync' },
  { employeeId: 'FY-260201-0006', role: 'manager', scopeId: 'org-store-jj01', createdBy: 'sync' },
  { employeeId: 'FY-260601-0008', role: 'manager', scopeId: 'org-store-gqc01', createdBy: 'sync' },
  { employeeId: 'FY-260101-0002', role: 'staff', scopeId: 'org-store-nc01', createdBy: 'sync' },
  { employeeId: 'FY-260101-0003', role: 'staff', scopeId: 'org-store-nc01', createdBy: 'sync' },
  { employeeId: 'FY-260101-0004', role: 'staff', scopeId: 'org-store-nc01', createdBy: 'sync' },
  { employeeId: 'FY-260201-0007', role: 'staff', scopeId: 'org-store-jj01', createdBy: 'sync' },
  { employeeId: 'FY-260101-0009', role: 'staff', scopeId: 'org-store-nc01', createdBy: 'sync' },
  { employeeId: 'FY-260101-0001', role: 'hr', scopeId: '16d1184b46db099a', createdBy: 'FY-260101-0001' },
]

const COMMISSION_RATES = [
  { orgId: '6707cc8b88579108', orderType: '销售单', roleType: '美容师', salesCategory: '自采自销', amountTierMin: '0.00', amountTierMax: '5000.00', commissionRate: '0.0800' },
  { orgId: '6707cc8b88579108', orderType: '销售单', roleType: '养生师', salesCategory: '自采自销', amountTierMin: '0.00', amountTierMax: '5000.00', commissionRate: '0.0800' },
  { orgId: '6707cc8b88579108', orderType: '销售单', roleType: '美容师', salesCategory: '自采自销', amountTierMin: '5000.00', amountTierMax: null, commissionRate: '0.1000' },
  { orgId: '6707cc8b88579108', orderType: '销售单', roleType: '养生师', salesCategory: '自采自销', amountTierMin: '5000.00', amountTierMax: null, commissionRate: '0.1000' },
  { orgId: '6707cc8b88579108', orderType: '销售单', roleType: '推广师', salesCategory: '自采自销', amountTierMin: '0.00', amountTierMax: null, commissionRate: '0.0500' },
  { orgId: '6707cc8b88579108', orderType: '服务单', roleType: '美容师', salesCategory: '自采自销', amountTierMin: '0.00', amountTierMax: null, commissionRate: '0.1200' },
  { orgId: '6707cc8b88579108', orderType: '服务单', roleType: '养生师', salesCategory: '自采自销', amountTierMin: '0.00', amountTierMax: null, commissionRate: '0.1200' },
  { orgId: 'dad2db0b1249daca', orderType: '销售单', roleType: '美容师', salesCategory: '自采自销', amountTierMin: '0.00', amountTierMax: '5000.00', commissionRate: '0.0800' },
  { orgId: 'dad2db0b1249daca', orderType: '销售单', roleType: '养生师', salesCategory: '自采自销', amountTierMin: '0.00', amountTierMax: '5000.00', commissionRate: '0.0800' },
  { orgId: 'dad2db0b1249daca', orderType: '销售单', roleType: '美容师', salesCategory: '自采自销', amountTierMin: '5000.00', amountTierMax: null, commissionRate: '0.1000' },
  { orgId: 'dad2db0b1249daca', orderType: '销售单', roleType: '养生师', salesCategory: '自采自销', amountTierMin: '5000.00', amountTierMax: null, commissionRate: '0.1000' },
  { orgId: '6707cc8b88579108', orderType: '销售单', roleType: '美容师', salesCategory: '他销自耗', amountTierMin: '0.00', amountTierMax: null, commissionRate: '0.0600' },
  { orgId: '6707cc8b88579108', orderType: '销售单', roleType: '养生师', salesCategory: '他销自耗', amountTierMin: '0.00', amountTierMax: null, commissionRate: '0.0600' },
]

const COUPON_TEMPLATES = [
  { templateId: 'coupon-tpl-001', name: '新客50元现金券', couponType: '现金券' as const, discountValue: '50.00', minSpend: '200.00', maxDiscount: null, totalCount: 500, applicableProductIds: null, applicableCategoryIds: null, applicableStoreIds: null, validityMode: 'days', validFrom: null, validTo: null, validDays: 30, description: '新客注册赠送，满200元可用', isActive: true },
  { templateId: 'coupon-tpl-002', name: '面部护理体验券', couponType: '品项券' as const, discountValue: '100.00', minSpend: '0', maxDiscount: null, totalCount: 200, applicableProductIds: null, applicableCategoryIds: ['cat-hr-01'], applicableStoreIds: null, validityMode: 'fixed', validFrom: new Date('2026-03-01T00:00:00Z'), validTo: new Date('2026-06-30T23:59:59Z'), validDays: null, description: '面部护理品类专享100元抵扣', isActive: true },
  { templateId: 'coupon-tpl-003', name: '会员日8.5折券', couponType: '折扣券' as const, discountValue: '0.85', minSpend: '500.00', maxDiscount: '200.00', totalCount: null, applicableProductIds: null, applicableCategoryIds: null, applicableStoreIds: ['store-nc01', 'store-nc02'], validityMode: 'fixed', validFrom: new Date('2026-03-15T00:00:00Z'), validTo: new Date('2026-03-15T23:59:59Z'), validDays: null, description: '会员日当天全场8.5折，封顶200元，满500可用，仅限南昌门店', isActive: true },
]

const OPERATION_LOGS = [
  { operatorEmployeeId: 'FY-260101-0001', operatorName: '张明', operatorRole: 'admin', orgNodeId: '16d1184b46db099a', orgNodeName: '总部', action: 'employee.create', targetType: 'employee', targetId: 'FY-260101-0009', detail: { name: '吴燕', phone: '13800138008', storeId: 'store-nc01', positionName: '美容师' }, source: 'adminApi', createdAt: new Date('2025-04-01T09:00:00Z') },
  { operatorEmployeeId: 'FY-260101-0001', operatorName: '张明', operatorRole: 'admin', orgNodeId: '16d1184b46db099a', orgNodeName: '总部', action: 'product.create', targetType: 'product', targetId: 'prod-008', detail: { name: '光子嫩肤仪器护理', categoryId: 'cat-hr-03', price: '880.00' }, source: 'adminApi', createdAt: new Date('2025-06-01T10:00:00Z') },
  { operatorEmployeeId: 'FY-260101-0001', operatorName: '张明', operatorRole: 'manager', orgNodeId: 'org-store-nc01', orgNodeName: '南昌旗舰店', action: 'order.create', targetType: 'sale_order', targetId: 'FY-XSD-WX-260310-0001', detail: { customerName: '林美', totalAmount: '2299.00', itemCount: 2 }, source: 'staffApi', createdAt: new Date('2026-03-10T10:30:00Z') },
  { operatorEmployeeId: 'FY-260101-0001', operatorName: '张明', operatorRole: 'manager', orgNodeId: 'org-store-nc01', orgNodeName: '南昌旗舰店', action: 'allocation.save', targetType: 'sale_order', targetId: 'FY-XSD-WX-260310-0001', detail: { allocations: [{ employeeId: 'FY-260101-0002', ratio: 0.8 }, { employeeId: 'FY-260101-0004', ratio: 0.2 }] }, source: 'staffApi', createdAt: new Date('2026-03-10T11:00:00Z') },
  { operatorEmployeeId: 'FY-260201-0006', operatorName: '孙浩', operatorRole: 'manager', orgNodeId: 'org-store-jj01', orgNodeName: '九江旗舰店', action: 'order.confirmOffline', targetType: 'sale_order', targetId: 'FY-XSD-WX-260311-0002', detail: { previousStatus: '待确认收款', newStatus: '已支付' }, source: 'staffApi', createdAt: new Date('2026-03-11T14:10:00Z') },
  { operatorEmployeeId: 'FY-260101-0002', operatorName: '刘芳', operatorRole: 'staff', orgNodeId: 'org-store-nc01', orgNodeName: '南昌旗舰店', action: 'service.complete', targetType: 'service_order', targetId: 'HLD-WX-2603110001', detail: { remainingSessions: { before: 10, after: 9 } }, source: 'staffApi', createdAt: new Date('2026-03-11T11:30:00Z') },
  { operatorEmployeeId: 'FY-260101-0001', operatorName: '张明', operatorRole: 'admin', orgNodeId: '16d1184b46db099a', orgNodeName: '总部', action: 'permission.assign', targetType: 'permission_role', targetId: '11', detail: { employeeId: 'FY-260101-0001', role: 'hr', scopeId: '16d1184b46db099a' }, source: 'adminApi', createdAt: new Date('2025-02-01T10:00:00Z') },

]

// ---------------------------------------------------------------------------
// Execute Seed
// ---------------------------------------------------------------------------

async function seed() {
  console.log('Seeding database...')

  await db.transaction(async (tx) => {
    // 1. org_nodes
    console.log('  org_nodes...')
    await tx.insert(orgNodes).values(ORG_NODES).onConflictDoNothing()

    // 2. stores
    console.log('  stores...')
    await tx.insert(stores).values(STORES).onConflictDoNothing()

    // 3. staff_wechat_users
    console.log('  staff_wechat_users...')
    await tx.insert(staffWechatUsers).values(STAFF).onConflictDoNothing()

    // 4. client_wechat_users
    console.log('  client_wechat_users...')
    await tx.insert(clientWechatUsers).values(CLIENTS).onConflictDoNothing()

    // 5a. product_categories — 一级分类（品项类型）
    console.log('  product_categories (kinds)...')
    await tx.insert(productCategories).values(PRODUCT_KINDS).onConflictDoNothing()

    // 5b. product_categories — 二级分类
    console.log('  product_categories (sub)...')
    await tx.insert(productCategories).values(PRODUCT_CATEGORIES).onConflictDoNothing()

    // 6. product_skus (SKU，独立实体)
    console.log('  product_skus...')
    await tx.insert(productSkus).values(PRODUCT_SKUS).onConflictDoNothing()

    // 7. mall_categories (商品分类)
    console.log('  mall_categories...')
    await tx.insert(mallCategories).values(MALL_CATEGORIES).onConflictDoNothing()

    // 8. products (商城商品)
    console.log('  products...')
    await tx.insert(products).values(PRODUCTS).onConflictDoNothing()

    // 9. mall_product_skus (商城商品-SKU关联)
    console.log('  mall_product_skus...')
    await tx.insert(mallProductSkus).values(MALL_PRODUCT_SKUS).onConflictDoNothing()

    // 8. sale_orders
    console.log('  sale_orders...')
    await tx.insert(saleOrders).values(SALE_ORDERS).onConflictDoNothing()

    // 9. sale_items
    console.log('  sale_items...')
    await tx.insert(saleItems).values(SALE_ITEMS).onConflictDoNothing()

    // 10. sale_allocations
    console.log('  sale_allocations...')
    await tx.insert(saleAllocations).values(SALE_ALLOCATIONS).onConflictDoNothing()

    // 11. appointments
    console.log('  appointments...')
    await tx.insert(appointments).values(APPOINTMENTS).onConflictDoNothing()

    // 12. service_orders
    console.log('  service_orders...')
    await tx.insert(serviceOrders).values(SERVICE_ORDERS).onConflictDoNothing()

    // 13. service_items
    console.log('  service_items...')
    await tx.insert(serviceItems).values(SERVICE_ITEMS).onConflictDoNothing()

    // 14. permission_roles
    console.log('  permission_roles...')
    await tx.insert(permissionRoles).values(PERMISSION_ROLES).onConflictDoNothing()

    // 15. commission_rate_matrix
    console.log('  commission_rate_matrix...')
    await tx.insert(commissionRateMatrix).values(COMMISSION_RATES).onConflictDoNothing()

    // 16. coupon_templates
    console.log('  coupon_templates...')
    await tx.insert(couponTemplates).values(COUPON_TEMPLATES).onConflictDoNothing()

    // 17. operation_logs
    console.log('  operation_logs...')
    await tx.insert(operationLogs).values(OPERATION_LOGS).onConflictDoNothing()
  })

  console.log('Seed complete!')
}

seed()
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })
  .finally(() => client.end())
