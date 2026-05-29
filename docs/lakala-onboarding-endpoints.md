# 拉卡拉「入网服务」16 接口契约 + 数据字典 + 附件枚举

> Phase 0 文档输出，Phase 1-3 所有后续 agent 的依赖。
> 抓取自 https://o.lakala.com/#/home/document/detail （官方开放平台 API 文档站）

## 文档元信息

| 项 | 值 |
|---|---|
| 抓取日期 | 2026-05-29 |
| 测试环境基址 (v2) | `https://test.wsmsd.cn/sit/api/v2/mms/openApi/` |
| 生产环境基址 (v2) | `https://s2.lakala.com/api/v2/mms/openApi/` |
| 测试环境基址 (v3 电子合同) | `https://test.wsmsd.cn/sit/api/v3/mms/open_api/ec/` |
| 生产环境基址 (v3 电子合同) | `https://s2.lakala.com/api/v3/mms/open_api/ec/` |
| 请求方法 | POST application/json |
| 签名算法 | SHA256withRSA（认证类型: `LKLAPI-SHA256withRSA`） |
| 签名 Header | `Authorization: LKLAPI-SHA256withRSA timestamp="${timeStamp}",nonce_str="${nonceStr}",signature="${signature}"` |
| 签名串构成 | `${timeStamp}\n${nonceStr}\n${body}\n` 三行串联，每行以 `\n`（0x0A）结束 |
| 公共请求字段 (v3) | `req_time` / `version=3.0` / `req_data` |
| 公共请求字段 (v2) | `ver=1.0.0` / `timestamp`（ms 字符串） / `reqId` / `reqData` |
| 公共响应字段 (v3) | `code` / `msg` / `resp_time` / `resp_data` |
| 公共响应字段 (v2) | `retCode` / `retMsg` / `respData` |
| 成功返回码 | `000000` |
| 备注 | v2 接口（商户进件/微信/支付宝/数据字典/附件）一直使用 `reqData` / `respData` 包络；v3 仅电子合同三接口使用 `req_data` / `resp_data` |

---

## 1. 公共参数（电子合同公共参数）

> 适用于 v3 电子合同申请 / 查询 / 下载 三接口。

### 公共请求参数

| 字段名 | 中文名称 | 必填 | 类型 | 说明 |
|---|---|---|---|---|
| req_time | 请求时间 | M | String(14) | 格式 yyyyMMddHHmmss |
| version | 版本号 | M | String(8) | 3.0 |
| req_data | 请求参数 | M | Object | 参见各接口的请求参数格式 |

### 公共响应参数

| 字段名 | 中文名称 | 必填 | 类型 | 说明 |
|---|---|---|---|---|
| code | 业务返回码 | M | String(8) | 000000 = 成功 |
| msg | 业务返回码描述 | M | String(64) | |
| resp_time | 响应时间 | M | String(14) | 格式 yyyyMMddHHmmss |
| resp_data | 响应数据 | M | Object | 参见各接口的响应参数格式 |

### v2 公共参数

v2（商户进件 / 微信 / 支付宝 / 附件 / 报备查询 / 信息变更）共用：

```json
{
  "reqData": { ... },
  "ver": "1.0.0",
  "timestamp": "1541589957000",
  "reqId": "32 位随机串"
}
```

响应：

```json
{
  "retCode": "000000",
  "retMsg": "成功",
  "respData": { ... }
}
```

---

## 2. 电子合同申请

- **path**: `/api/v3/mms/open_api/ec/apply`
- **方法**: POST
- **测试环境**: `https://test.wsmsd.cn/sit/api/v3/mms/open_api/ec/apply`
- **生产环境**: `https://s2.lakala.com/api/v3/mms/open_api/ec/apply`

提供与拉卡拉进行电子签约的第四方进行电子合同申请。签约成功后无需下载附件上传，仅需将 `ecNo` 在「新增商户进件」接口的 `contractNo` 字段中传入即可。

### 合同类别（凤御使用 EC015 / EC010）

| 编码 | 合同名称 | 适用场景 | 状态 |
|---|---|---|---|
| EC008 | 特约商户支付服务合作协议V4.1 | 商户入网 | 历史存量，推荐 EC015 |
| EC010 | 特约商户支付服务合作协议V4.1+清分结算授权委托书 | 商户入网+分账 | **当前最新** |
| EC011 | 清分结算授权委托书 | 分账业务 | **当前最新** |
| EC015 | 特约商户支付服务合作协议V4.2 | 商户入网 | **当前最新** |

### 请求参数（req_data）

| 字段 | 说明 | 必选 | 类型 | 备注 |
|---|---|---|---|---|
| order_no | 四方机构自定义订单号 | M | String(32) | 平台编号 + 14 位 yyyyMMddHHmmss + 8 位随机串 |
| org_id | 机构号 | M | Integer | 拉卡拉机构号 |
| ec_type_code | 合同类别 | M | String(12) | EC015 / EC010 等 |
| cert_type | 法人/经营者证件类型 | M | String(16) | RESIDENT_ID / PASSPORT / HK_MACAO_PASS / TAIWAN_PASS |
| cert_name | 法人/经营者姓名 | M | String(32) | |
| cert_no | 法人/经营者证件号 | M | String(32) | |
| mobile | 签约手机号 | M | String(16) | 不可修改，请慎重填写 |
| business_license_no | 营业执照号 | C | String(32) | 个体/企业必传 |
| business_license_name | 营业执照名称 | C | String(32) | 个体/企业必传 |
| openning_bank_code | 结算开户行号 | M | String(32) | |
| openning_bank_name | 结算开户行名称 | M | String(128) | |
| acct_type_code | 结算卡性质 | M | String(2) | 57 对公 / 58 对私 |
| acct_no | 结算卡号 | M | String(32) | |
| acct_name | 结算卡名称 | M | String(64) | |
| ec_content_parameters | 电子合同内容参数集合 | M | JSONString | 按合同类型(ecTypeCode)传递不同集合 |
| agent_tag | 是否经办签约 | C | Integer(1) | 0 不启用 / 1 启用，缺省 0 |
| agent_name | 经办人名称 | C | String(32) | agentTag=1 必传 |
| agent_cert_type | 经办人证件类型 | C | String(32) | agentTag=1 必传 |
| agent_cert_no | 经办人证件号 | C | String(32) | agentTag=1 必传 |
| agent_file_name | 经办授权委托书文件名 | C | String(32) | agentTag=1 必传 |
| agent_file_path | 经办授权委托书文件路径 | C | String(128) | agentTag=1 必传 |
| remark | 备注说明 | C | String(128) | |
| ret_url | 签约结果回调通知地址 | C | String(128) | 成功签约才通知 |

### 响应参数（resp_data）

| 字段 | 说明 | 必选 | 类型 | 备注 |
|---|---|---|---|---|
| code | 返回码 | M | String(6) | 000000 = 成功 |
| message | 返回码描述 | M | String(128) | |
| data | 结果信息集合 | M | Object | |
| order_no | 请求订单号 | M | String(32) | |
| ec_apply_id | 电子签约申请受理编号 | M | Long | |
| result_url | H5 链接地址 | M | String | 申请成功=待签约 H5；申请失败=错误信息 H5 |

### 异步签约结果通知（respData 部分）

| 字段 | 说明 | 必选 | 类型 | 备注 |
|---|---|---|---|---|
| version | 版本号 | M | String(32) | 1.0 |
| orgId | 机构号 | M | Integer | 合同所属机构号 |
| orderNo | 请求订单号 | M | String(32) | |
| ecApplyId | 电子签约申请受理编号 | M | Long | |
| ecNo | 电子合同号 | M | String(32) | 如 QT20210914000216202 |
| ecName | 电子合同名称 | M | String(32) | 特约商户支付服务合作协议V3.1 |
| ecStatus | 电子合同签署状态 | M | String(32) | UNDONE 未完成 / COMPLETED 已完成 |

### 关键错误码

| Code | 描述 | 备注 |
|---|---|---|
| 000000 | 交易成功 | |
| 087900 | 三四要素认证失败 | 此状态下可申请转人工复核 |
| 087901 | 手机号实名认证不通过 | |

---

## 3. 电子合同查询

- **path**: `/api/v3/mms/open_api/ec/q_status`
- **测试环境**: `https://test.wsmsd.cn/sit/api/v3/mms/open_api/ec/q_status`
- **生产环境**: `https://s2.lakala.com/api/v3/mms/open_api/ec/q_status`

提供已申请的电子合同状态查询。

### 请求参数

| 字段 | 说明 | 必选 | 类型 | 备注 |
|---|---|---|---|---|
| version | 接口版本号 | M | String(32) | 1.0 |
| order_no | 四方机构自定义订单号 | M | String(32) | |
| org_code | 机构号 | M | Integer | |
| ec_apply_id | 申请受理号 | M | Long | 申请接口返回的编号 |

### 响应参数

| 字段 | 说明 | 必选 | 类型 | 备注 |
|---|---|---|---|---|
| code | 返回码 | M | String(6) | |
| message | 返回码描述 | M | String(128) | |
| data | 结果集合 | M | Object | |
| order_no | 请求订单号 | M | String(32) | |
| ec_apply_id | 申请受理号 | M | Long | |
| ec_status | 电子合同状态 | M | String | UNDONE 未完成 / COMPLETED 已完成 |
| ec_no | 电子合同号 | C | String | 签署完成后才返回 |

---

## 4. 电子合同下载

- **path**: `/api/v3/mms/open_api/ec/download`
- **测试环境**: `https://test.wsmsd.cn/sit/api/v3/mms/open_api/ec/download`
- **生产环境**: `https://s2.lakala.com/api/v3/mms/open_api/ec/download`

下载已完成签约的电子合同 PDF。

### 请求参数

| 字段 | 说明 | 必选 | 类型 | 备注 |
|---|---|---|---|---|
| version | 接口版本号 | M | String(32) | 1.0 |
| order_no | 四方机构自定义订单号 | M | String(32) | |
| org_code | 机构号 | M | Integer | |
| ec_apply_id | 申请受理号 | M | Long | |

### 响应参数

| 字段 | 说明 | 必选 | 类型 | 备注 |
|---|---|---|---|---|
| code | 返回码 | M | String(6) | |
| message | 返回码描述 | M | String(128) | |
| order_no | 请求订单号 | M | String | |
| ec_apply_id | 申请受理号 | M | Long | |
| ec_status | 状态 | M | String | UNDONE / COMPLETED |
| ec_no | 电子合同号 | C | String | COMPLETED 时返回 |
| ec_file | PDF base64 串（urlSafe） | C | String | 完成时返回。服务端用 spring `Base64Utils.encodeToUrlSafeString`；客户端用 `Base64Utils.decodeFromUrlSafeString` 解码 |

### 特殊说明

- 仅签署完成（COMPLETED）的合同才有 `ec_file` 内容。
- base64 字符串采用 URL Safe 变体，注意 `+/=` 替换为 `-_` 的差异。

---

## 5. 附件上传

- **path**: `/api/v2/mms/openApi/uploadFile`
- **测试环境**: `https://test.wsmsd.cn/sit/api/v2/mms/openApi/uploadFile`
- **生产环境**: `https://s2.lakala.com/api/v2/mms/openApi/uploadFile`

接入方上传商户入网附件。**进件前上传附件，上传完成后必须在 24 小时内根据 orderNo 提交进件信息，超过 24 小时附件失效。**

### 请求参数（reqData）

| 字段 | 约束 | 类型 | 长度 | 描述 | 取值说明 |
|---|---|---|---|---|---|
| version | 必传 | String | 8 | 接口版本号 | 1.0 |
| orderNo | 必传 | String | 32 | 订单编号 | 14 位 yyyyMMddHHmmss + 8 位随机串 |
| orgCode | 必传 | String | 32 | 机构代码 | |
| attType | 必传 | String | 32 | 附件类型 | 见附件类型枚举 |
| attExtName | 必传 | String | 32 | 附件扩展名 | jpg / png / pdf；5M 以内 |
| attContext | 必传 |  |  | 附件内容 | Base64（spring `Base64Utils.encodeToString`，非 URL Safe） |

### 响应参数（respData）

| 字段 | 类型 | 描述 |
|---|---|---|
| orgCode | String | 机构代码 |
| orderNo | String | 订单号 |
| attFileId | String | 附件 ID（用于进件接口 fileData[].attFileId） |
| attType | String | 附件类型 |

### 附件类型 enum 完整列表

| 附件类型 | 枚举值 | 进件备注 | 分账备注 |
|---|---|---|---|
| 法人身份证正面 | `FR_ID_CARD_FRONT` | 必传 | |
| 法人身份证反面 | `FR_ID_CARD_BEHIND` | 必传 | |
| 结算人身份证正面 | `ID_CARD_FRONT` | 同法人结算可不传，非法人结算必传 | |
| 结算人身份证反面 | `ID_CARD_BEHIND` | 同法人结算可不传，非法人结算必传 | |
| 银行卡 | `BANK_CARD` | 必传 | |
| 营业执照 | `BUSINESS_LICENCE` | 企业商户必传，小微可不传 | |
| 商户门头照 | `MERCHANT_PHOTO` | 必传 | 集市现场照片 |
| 商铺内部照片 | `SHOPINNER` | 必传 | - |
| 线下纸质协议 | `XY` | 线下签署上传 | - |
| 电子协议 | `NETWORK_XY` | 电子协议 | - |
| 租赁合同 | `HT` | 报名教培优惠需要 | - |
| 合作资质证明 | `COOPERATION_QUALIFICATION_PROOF` | 合作资质证明 | - |
| 食品经营相关资质 | `FOOD_QUALIFICATION_PROOF` | 食品经营资质 | - |
| 非法人结算授权书 | `NO_LEGAL_PERSON_SETT_AUTH_LETTER` | 非法人结算授权书 | - |
| 结算授权委托书 | `SPLIT_ENTRUST_FILE` | - | 结算委托授权书 |
| 集市方与场地方间的租赁协议 | `RENTAL_AGREEMENT` | - | 集市方与场地方间的租赁协议 |
| 集市方与摊主间的合作协议 | `SPLIT_COOPERATION_FILE` | - | 集市方与摊主间的合作协议 |
| 其他 | `OTHERS` | 其他 | 合作协议；集市媒体公告信息；其他 |

> 灰色区域（进件备注列）表示进件接口支持该附件类型；分账场景的特有附件在分账备注列。

---

## 6. 新增商户进件

- **path**: `/api/v2/mms/openApi/addMer`
- **测试环境**: `https://test.wsmsd.cn/sit/api/v2/mms/openApi/addMer`
- **生产环境**: `https://s2.lakala.com/api/v2/mms/openApi/addMer`

接入方通过开放平台新增商户进件。

### 请求参数（reqData）

| 字段 | 约束 | 类型 | 长度 | 描述 | 取值说明 |
|---|---|---|---|---|---|
| version | 必传 | String | 8 | 接口版本号 | 1.0 |
| orderNo | 必传 | String | 32 | 订单编号 | |
| posType | 必传 | String | 32 | 进件 POS 类型 | 见【POS 类型字典表】 |
| orgCode | 必传 | String | 32 | 机构代码 | 测试环境=1 |
| merRegName | 必传 | String | 80 | 商户注册名称 | 8~40 字符，不可纯数字，小微不得含「有限公司」 |
| merBizName | 可传 | String | 64 | 商户经营名称 | 为空时同注册名 |
| merRegDistCode | 必传 | String | 8 | 商户地区代码 | 见【地区码】 |
| merRegAddr | 必传 | String | 80 | 商户详细地址 | 去省市区，6-200 字符 |
| mccCode | 必传 | String | 8 | 商户 MCC 编号 | 见【MCC 对照表】 |
| merBlisName | 可传 | String | 80 | 营业执照名称 | 小微可不传 |
| merBlis | 可传 | String | 40 | 营业执照号 | 小微可不传，对公必传且不可与法人证件相同 |
| merBlisStDt | 可传 | String | 10 | 营业执照开始日期 | yyyy-MM-dd，有执照时必传 |
| merBlisExpDt | 可传 | String | 10 | 营业执照有效期 | yyyy-MM-dd，有执照时必传 |
| merBusiContent | 必传 | String | 64 | 商户经营内容 | 见【经营内容字典表】 |
| larName | 必传 | String | 20 | 法人姓名 | |
| larIdType | 必传 | String | 8 | 法人证件类型 | 见【证件类型字典表】 |
| larIdcard | 必传 | String | 40 | 法人身份证号 | |
| larIdcardStDt | 必传 | String | 10 | 法人证件开始日期 | yyyy-MM-dd |
| larIdcardExpDt | 必传 | String | 10 | 法人证件有效期 | yyyy-MM-dd |
| merContactMobile | 必传 | String | 20 | 联系人手机号 | |
| merContactName | 必传 | String | 32 | 联系人姓名 | |
| shopName | 可传 | String | 80 | 网点名称 | 缺省取商户注册名 |
| shopDistCode | 可传 | String | 8 | 网点地区代码 | 缺省取商户地区代码 |
| shopAddr | 可传 | String | 80 | 网点详细地址 | 缺省取商户详细地址 |
| shopContactName | 可传 | String | 32 | 网点联系人 | 缺省取商户联系人 |
| shopContactMobile | 可传 | String | 20 | 网点联系人手机 | 缺省取商户联系人手机 |
| openningBankCode | 必传 | String | 20 | 结算开户行号 | 可由【卡 BIN 查询】 |
| openningBankName | 必传 | String | 40 | 结算开户行名称 | |
| clearingBankCode | 必传 | String | 20 | 结算清算行号 | |
| acctNo | 必传 | String | 40 | 结算账户账号 | |
| acctName | 必传 | String | 40 | 结算账户名称 | |
| acctTypeCode | 必传 | String | 8 | 结算账户性质 | 57 对公 / 58 对私 |
| settlePeriod | 必传 | String | 8 | 结算周期 | 见【结算周期字典表】 |
| clearDt | 可选 | String | 16 | 日切时间 | 见【日切时间字典表】，默认 TWENTY_THREE |
| acctIdType | 可选 | String | 8 | 结算人证件类型 | 为空判定为同法人 |
| acctIdcard | 可选 | String | 40 | 结算人证件号码 | 为空判定为同法人 |
| acctIdDt | 可选 | String | 10 | 结算人证件有效期 | 为空判定为同法人 |
| devSerialNo | 可选 | String | 64 | 终端设备序列号 | |
| devTypeName | 可选 | String | 32 | 设备型号 | |
| termVer | 可选 | String | 32 | 终端版本号 | |
| salesStaff | 可选 | String | 15 | 销售人员 | |
| termNum | 可选 | String | 8 | 终端数量 | 最大 5 个终端 |
| retUrl | 必传 | String | 64 | 回调地址 | URL |
| feeData | 必传 | Set |  | 费率信息集合 | 见下方 |
| fileData | 可选 | Set |  | 附件信息集合 | |
| contractNo | 可选 | String | 64 | 电子合同编号 | 部分进件类型要求录入 |
| feeAssumeType | 可选 | String | 15 | 大额理财-手续费承担方 | PAYERASSUME / PAYEEASSUME / LINEASSUME |
| amountOfMonth | 可选 | String | 32 | 大额理财-最小月交易额 | |
| serviceFee | 可选 | String | 32 | 大额理财-收取服务费 | |

#### feeData 费率信息集合

| 字段 | 约束 | 类型 | 描述 | 取值说明 |
|---|---|---|---|---|
| feeRateTypeCode | 必传 | String | 费率类型 | 见费率类型字典表（本项目不展示费率，故略） |
| feeRateTypeName | 必传 | String | 费率类型名称 | 如「银行卡借记卡」 |
| feeRatePct | 必传 | String | 手续费率(%) | 如 0.6 |
| feeUpperAmtPcnt | 可选 | String | 单笔手续费封顶 | 默认不封顶，单位元 |
| feeLowerAmtPcnt | 可选 | String | 单笔手续费保底 | 默认无保底，单位元 |
| feeRateStDt | 可选 | String | 手续费生效日期 | 默认进件日 |

#### fileData 附件列表

| 字段 | 约束 | 类型 | 描述 |
|---|---|---|---|
| attFileId | 必传 | String | 附件上传接口返回的 ID |
| attType | 必传 | String | 附件类型（见上方 enum） |

### 响应参数（respData）

| 字段 | 类型 | 描述 |
|---|---|---|
| orgCode | String | 机构代码 |
| orderNo | String | 订单号 |
| contractId | String | 进件 ID（后续查询 / 复议 / 回调用） |

---

## 7. 进件信息查询

- **path**: `/api/v2/mms/openApi/queryContract`
- **测试环境**: `https://test.wsmsd.cn/sit/api/v2/mms/openApi/queryContract`
- **生产环境**: `https://s2.lakala.com/api/v2/mms/openApi/queryContract`

接入方查询进件信息，返回报文同进件审核完成主动通知报文。

### 请求参数（reqData）

| 字段 | 约束 | 类型 | 长度 | 描述 |
|---|---|---|---|---|
| version | 必传 | String | 8 | 1.0 |
| orderNo | 必传 | String | 32 | 订单编号 |
| orgCode | 必传 | String | 32 | 机构代码 |
| contractId | 必传 | String | 32 | 进件 ID |

### 响应参数（respData）

| 字段 | 类型 | 描述 |
|---|---|---|
| orgCode | String | 机构代码 |
| orderNo | String | 订单号 |
| contractId | String | 进件 ID |
| contractStatus | String | 进件状态：NO_COMMIT / COMMIT / COMMIT_FAIL / MANUAL_AUDIT / REVIEW_ING / WAIT_FOR_CONTACT / INNER_CHECK_REJECTED |
| contractMemo | String | 进件描述（驳回时为具体理由） |
| merInnerNo | String | 拉卡拉内部商户号（审核通过才有）|
| merCupNo | String | 银联商户号（审核通过才有）|
| termDatas | Set | 终端列表（审核通过、增商/增终才有）|
| └─ shopId | String | 网点编号 |
| └─ termId | String | 终端编号 |
| └─ termNo | String | 终端号 |
| └─ busiTypeCode | String | 业务代码（见【业务类型字典表】）|
| └─ busiTypeName | String | 业务名称 |
| └─ productName | String | 产品名称 |
| └─ productCode | String | 产品代码 |
| └─ devSerialNo | String | 终端设备序列号 |

### 进件状态枚举说明

| code | 中文 | 说明 |
|---|---|---|
| NO_COMMIT | 未提交 | |
| COMMIT | 已提交 | |
| COMMIT_FAIL | 提交失败 | |
| MANUAL_AUDIT | 转人工审核 | |
| REVIEW_ING | 审核中 | |
| WAIT_FOR_CONTACT | 审核通过 | 表面是"待联系"但实际表示审核完成 |
| INNER_CHECK_REJECTED | 审核驳回 | |

---

## 8. 进件回调通知

- **path**: 接入方提供的 `retUrl`（进件接口里上送）
- **方向**: 拉卡拉 → 接入方
- **签名**: 同公共签名规则（SHA256withRSA），Header 带 `Authorization` 包 timestamp/nonce_str/signature
- **特殊说明**: 接入方需被动接收通知

### 通知报文字段（dataPacket.data）

| 字段 | 约束 | 类型 | 描述 |
|---|---|---|---|
| code | 必返 | String | 000000=成功，否则具体错误码 |
| message | 必返 | String | 描述 |
| data | 必返 | Object | 业务数据 |
| └─ orgCode | 必返 | String | 机构代码 |
| └─ orderNo | 必返 | String | 订单号 |
| └─ contractId | 必返 | String | 进件 ID |
| └─ contractStatus | 必返 | String | 进件状态（同进件查询）|
| └─ contractMemo | 必返 | String | 进件描述 |
| └─ merInnerNo | 非必返 | String | 拉卡拉内部商户号（审核通过才有）|
| └─ merCupNo | 非必返 | String | 银联商户号（审核通过才有）|
| └─ termDatas | 非必返 | Set | 终端列表（同进件查询，多了 activeNo 激活码）|
| └─ └─ activeNo | 非必返 | String | 激活码 |

### 接入方响应报文（同步 ACK）

| 字段 | 约束 | 类型 | 长度 | 描述 |
|---|---|---|---|---|
| code | 必返 | String | 32 | SUCCESS=成功 / FAIL=失败 |
| message | 必返 | String | 64 | 异常信息 |

```json
{"code":"SUCCESS","message":"成功"}
```

### 签名要求

- 认证方式: SHA256withRSA
- 签名串: `${timeStamp}\n${nonceStr}\n${body}\n`（每行以 \n 结束，包括最后一行）
- Header: `Authorization: LKLAPI-SHA256withRSA timestamp="${timeStamp}",nonce_str="${nonceStr}",signature="${signature}"`
- 接入方需用拉卡拉公钥验签

---

## 9. 进件复议提交

- **path**: `/api/v2/mms/openApi/reconsiderSubmit`
- **测试环境**: `https://test.wsmsd.cn/sit/api/v2/mms/openApi/reconsiderSubmit`
- **生产环境**: `https://s2.lakala.com/api/v2/mms/openApi/reconsiderSubmit`

进件被驳回（系统自动校验未通过）后，接入方调用此接口转人工审核。

### 请求参数（reqData）

| 字段 | 约束 | 类型 | 长度 | 描述 |
|---|---|---|---|---|
| version | 必传 | String | 8 | 1.0 |
| orderNo | 必传 | String | 32 | 订单编号 |
| orgCode | 必传 | String | 32 | 机构代码 |
| contractId | 必传 | String | 32 | 进件 ID |

### 响应参数（respData）

| 字段 | 类型 | 描述 |
|---|---|---|
| orgCode | String | 机构代码 |
| orderNo | String | 订单号 |

### 关键错误码示例

| Code | 描述 |
|---|---|
| OP10102 | 三代进件进件复议提交失败（当前进件状态不可复议）|

### 特殊说明

- 仅在 `contractStatus = INNER_CHECK_REJECTED` 时可调用。
- 已是 COMMIT / MANUAL_AUDIT / WAIT_FOR_CONTACT 等状态调用会失败。

---

## 10. 商户报备结果查询

- **path**: `/api/v2/mms/openApi/querySubMerInfo`
- **测试环境**: `https://test.wsmsd.cn/sit/api/v2/mms/openApi/querySubMerInfo`
- **生产环境**: `https://s2.lakala.com/api/v2/mms/openApi/querySubMerInfo`

查询报备结果（含成功 / 失败记录）。

### 请求参数（reqData）

| 字段 | 约束 | 类型 | 长度 | 描述 |
|---|---|---|---|---|
| version | 必传 | String | 8 | 1.0 |
| orderNo | 必传 | String | 32 | 订单编号 |
| orgCode | 必传 | String | 32 | 机构代码 |
| merInnerNo | 可传 | String | 32 | 拉卡拉内部商户号（与 merCupNo 二选一，都送以内部为准）|
| merCupNo | 可传 | String | 32 | 银联商户号 |
| registerChannel | 可选 | String | 8 | 报备渠道 |
| registerType | 可选 | String | 64 | 报备类型 |
| registerStatus | 可选 | String | 64 | 报备状态：SUCCESS / FAIL |
| subMchId | 可选 | String | 64 | 子商户号 |

### registerChannel 报备渠道枚举

| Code | 中文 |
|---|---|
| UNIONPAY | 银联 |
| NETUNION | 网联 |
| UNIONPAY_NEIMENG | 内蒙银联 |
| NETPURSE | 网联小钱包 |
| CODEPAYIFS | 条码支付综合前置 |
| ALIPAY_FLOWER | 支付宝健康分 |
| ICBC | 工行 |
| ABC | 农行 |
| BCM | 交行 |
| CCB | 建行 |
| BCM_ORG | 交行机构 |
| NUCC | 新网联 |
| ICBC_UMBRELLA | 工行伞底钱包 |
| CMB | 招行 |
| CIB | 兴业 |

### registerType 报备类型枚举

| Code | 中文 |
|---|---|
| ZFBZF | 支付宝 |
| WXZF | 微信 |
| SNZF | 苏宁钱包 |
| YZF | 翼支付 |
| SZHB | 数字货币 |
| NUCC | 互联互通 |
| UNION | 银联二维码 |

### 响应参数（respData）

| 字段 | 类型 | 描述 |
|---|---|---|
| orgCode | String | 机构代码 |
| orderNo | String | 订单号 |
| list | Set | 报备明细集合 |

#### 报备信息集合元素

| 字段 | 类型 | 描述 |
|---|---|---|
| merInnerNo | String | 内部商户号（400/500 商户号）|
| subMchId | String | 子商户号 |
| subMchIdBank | String | 交易子商户号 |
| dcWalletId | String | 数币钱包 ID |
| channelId | String | 渠道号 |
| receOrgNo | String | 从业机构号 |
| registerChannel | String | 报备渠道 |
| registerType | String | 报备类型 |
| registerTm | String | 报备时间 |
| registerStatus | String | 报备状态 SUCCESS / FAIL |
| resultCode | String | 结果返回码 |
| resultMessage | String | 结果描述 |

---

## 11. 商户信息变更

- **path**: `/api/v2/mms/openApi/changeMer`
- **测试环境**: `https://test.wsmsd.cn/sit/api/v2/mms/openApi/changeMer`
- **生产环境**: `https://s2.lakala.com/api/v2/mms/openApi/changeMer`

接入方变更商户基本信息。

### 变更范围分支

| termNo | 变更范围 |
|---|---|
| 空 | 商户层结算配置信息 |
| 非空 | 业务层结算配置信息（原来没配过结算信息则不变更） |
| 非空 | 网点层信息（含网点名称/地址等） |

### 请求参数（reqData）

| 字段 | 约束 | 类型 | 长度 | 描述 |
|---|---|---|---|---|
| version | 必传 | String | 8 | 1.0 |
| orderNo | 必传 | String | 32 | 订单编号 |
| orgCode | 必传 | String | 32 | 机构代码 |
| merInnerNo | 必传 | String | 32 | 拉卡拉内部商户号（与 merCupNo 二选一）|
| merCupNo | 必传 | String | 32 | 银联商户号 |
| merRegName | 可传 | String | 64 | 商户注册名称 |
| merBizName | 可传 | String | 64 | 商户经营名称 |
| merRegDistCode | 可传 | String | 16 | 商户地区代码 |
| merRegAddr | 可传 | String | 128 | 商户详细地址 |
| mccCode | 可传 | String | 8 | MCC 编号 |
| merBlisName | 可传 | String | 64 | 营业执照名称 |
| merBlis | 可传 | String | 32 | 营业执照号 |
| merBlisStDt | 可传 | String | 10 | 营业执照开始日期 |
| merBlisExpDt | 可传 | String | 10 | 营业执照有效期 |
| merBusiContent | 可传 | String | 32 | 商户经营内容 |
| larName | 可传 | String | 32 | 法人姓名 |
| larIdcard | 可传 | String | 32 | 法人证件号 |
| larIdType | 可传 | String | 32 | 法人证件类型 |
| larIdcardStDt | 可传 | String | 10 | 法人证件开始日期 |
| larIdcardExpDt | 可传 | String | 10 | 法人证件有效期 |
| merContactMobile | 可传 | String | 32 | 联系人手机 |
| merContactName | 可传 | String | 32 | 联系人姓名 |
| fileData | 可传 | Set |  | 附件集合 |
| termNo | 可传 | String | 32 | 终端号（决定变更范围）|
| shopName | 可传 | String | 80 | 网点名称（termNo 为空时忽略）|
| shopDistCode | 可传 | String | 8 | 网点地区代码（termNo 为空时忽略）|
| shopAddr | 可传 | String | 80 | 网点详细地址（termNo 为空时忽略）|
| shopContactName | 可传 | String | 32 | 网点联系人（termNo 为空时忽略）|
| shopContactMobile | 可传 | String | 20 | 网点联系人手机（termNo 为空时忽略）|
| openningBankCode | 可传 | String | 20 | 结算开户行号（termNo 为空=变更商户层结算）|
| openningBankName | 可传 | String | 40 | 结算开户行名称 |
| clearingBankCode | 可传 | String | 20 | 结算清算行号 |
| acctNo | 可传 | String | 40 | 结算账号 |
| acctName | 可传 | String | 40 | 结算账户名称 |
| acctTypeCode | 可传 | String | 8 | 结算账户性质 |
| settlePeriod | 可传 | String | 8 | 结算周期 |
| clearDt | 可选 | String | 16 | 日切时间 |
| acctIdType | 可选 | String | 8 | 结算人证件类型 |
| acctIdcard | 可选 | String | 40 | 结算人证件号码 |
| acctIdDt | 可选 | String | 10 | 结算人证件有效期 |
| retUrl | 必传 | String | 64 | 回调地址 |

### 响应参数（respData）

| 字段 | 类型 | 描述 |
|---|---|---|
| orgCode | String | 机构代码 |
| orderNo | String | 订单号 |
| contractId | String | 进件 ID（变更单 ID）|

---

## 12. 支付宝微信商户开户状态查询

- **path**: `/api/v2/mms/sme/mrchAuthStateQuery`
- **测试环境**: `https://test.wsmsd.cn/sit/api/v2/mms/sme/mrchAuthStateQuery`
- **生产环境**: `https://s2.lakala.com/api/v2/mms/sme/mrchAuthStateQuery`

查询微信 / 支付宝商户开户授权状态。

### 请求参数（req 部分）

| 字段 | 约束 | 类型 | 长度 | 描述 | 取值 |
|---|---|---|---|---|---|
| tradeMode | 必传 | String | 32 | 交易钱包类型 | ALIPAY / WECHAT |
| subMerchantId | 必传 | String | 32 | 子商户号 | |
| merchantNo | 必传 | String | 64 | 商户号 | |

### 响应参数（respData 部分）

| 字段 | 类型 | 描述 |
|---|---|---|
| subMerchantId | String | 子商户号 |
| checkResult | String | 检查结果（按 tradeMode 不同）|

#### checkResult 枚举（微信）

| Code | 中文 |
|---|---|
| AUTHORIZE_STATE_UNAUTHORIZED | 未授权 |
| AUTHORIZE_STATE_AUTHORIZED | 已授权 |

#### checkResult 枚举（支付宝）

| Code | 中文 |
|---|---|
| AUTHORIZED | 已确认 |
| UNAUTHORIZED | 未确认 |
| CLOSED | 已销户 |
| SMID_NOT_EXIST | smid 不存在 |

---

## 13. 微信实名认证结果查询

- **path**: `/api/v2/mms/openApi/wechatRealNameQuery`
- **测试环境**: `https://test.wsmsd.cn/sit/api/v2/mms/openApi/wechatRealNameQuery`
- **生产环境**: `https://s2.lakala.com/api/v2/mms/openApi/wechatRealNameQuery`

### 请求参数（reqData）

| 字段 | 约束 | 类型 | 长度 | 描述 |
|---|---|---|---|---|
| version | 必传 | String | 8 | 1.0 |
| orderNo | 必传 | String | 32 | 订单编号 |
| orgCode | 必传 | String | 32 | 机构代码 |
| merInnerNo | 必传 | String | 32 | 拉卡拉内部商户号 |
| subMchId | 选传 | String | 32 | 子商户号 |
| channelId | 选传 | String | 32 | 渠道号（建议传，定位渠道用，仅支持拉卡拉渠道查询）|

### 响应参数（respData）

| 字段 | 类型 | 描述 |
|---|---|---|
| merInnerNo | String | 拉卡拉内部商户号 |
| subMchId | String | 账户端子商户号 |
| channelId | String | 渠道号 |
| receOrgNo | String | 从业机构号 |
| applymentId | String | 申请编号 |
| applymentState | String | 申请状态（见下）|
| authorizeState | String | 认证状态 AUTHORIZE_STATE_UNAUTHORIZED / AUTHORIZE_STATE_AUTHORIZED |
| registerChannel | Set | 报备通道 |
| qrcodeData | String | 小程序码图片 base64（部分状态返回，可直接 <img src="data:image/png;base64,..."> 渲染）|
| rejectParameter | String | 驳回参数 |
| rejectReason | String | 驳回原因 |

#### applymentState 枚举

| Code | 中文 |
|---|---|
| APPLYMENT_STATE_FAIL | 提交失败 |
| APPLYMENT_STATE_COMMIT | 已提交 |
| APPLYMENT_STATE_WAITTING_FOR_AUDIT | 审核中 |
| APPLYMENT_STATE_EDITTING | 编辑中 |
| APPLYMENT_STATE_WAITTING_FOR_CONFIRM_CONTACT | 待确认联系信息 |
| APPLYMENT_STATE_WAITTING_FOR_CONFIRM_LEGALPERSON | 待账户验证 |
| APPLYMENT_STATE_PASSED | 审核通过 |
| APPLYMENT_STATE_REJECTED | 审核驳回 |
| APPLYMENT_STATE_FREEZED | 已冻结 |
| APPLYMENT_STATE_CANCELED | 已作废 |

> qrcodeData 在 WAITTING_FOR_CONFIRM_CONTACT / WAITTING_FOR_CONFIRM_LEGALPERSON / PASSED / FREEZED 时返回。

---

## 14. 微信实名修改提交

- **path**: `/api/v2/mms/openApi/wechatRealName/modifyCommit`
- **测试环境**: `https://test.wsmsd.cn/sit/api/v2/mms/openApi/wechatRealName/modifyCommit`
- **生产环境**: `https://s2.lakala.com/api/v2/mms/openApi/wechatRealName/modifyCommit`

### 请求参数（reqData）

| 字段 | 约束 | 类型 | 长度 | 描述 |
|---|---|---|---|---|
| version | 必传 | String | 8 | 1.0 |
| orderNo | 必传 | String | 32 | 订单编号 |
| orgCode | 必传 | String | 32 | 机构代码 |
| merInnerNo | 必传 | String | 32 | 拉卡拉内部商户号 |
| receOrgNo | 必传 | String | 32 | 受理机构号 |
| subMchId | 必传 | String | 32 | 子商户号 |
| channelId | 必传 | String | 32 | 渠道号 |
| applymentId | 选传 | String | 32 | 申请编号（查询返回 ID 时必传，否则按新增实名处理）|

### 响应参数（respData）

| 字段 | 类型 | 描述 |
|---|---|---|
| retCode | String | 返回码 |
| retMsg | String | 返回码描述 |

---

## 15. 支付宝实名认证信息查询

- **path**: `/api/v2/mms/openApi/alipayRealNameQuery`
- **测试环境**: `https://test.wsmsd.cn/sit/api/v2/mms/openApi/alipayRealNameQuery`
- **生产环境**: `https://s2.lakala.com/api/v2/mms/openApi/alipayRealNameQuery`

### 请求参数（reqData）

| 字段 | 约束 | 类型 | 长度 | 描述 |
|---|---|---|---|---|
| version | 必传 | String | 8 | 1.0 |
| orderNo | 必传 | String | 32 | 订单编号 |
| orgCode | 必传 | String | 32 | 机构代码 |
| merInnerNo | 必传 | String | 32 | 拉卡拉内部商户号 |
| subMchId | 必传 | String | 32 | 子商户号 |
| channelId | 选传 | String | 32 | 支付宝来源（建议传，仅支持拉卡拉渠道查询）|
| realNameType | 选传 | String | 32 | 实名认证类型 ZFBZF=支付宝 |

### 响应参数（respData）

| 字段 | 类型 | 描述 |
|---|---|---|
| merInnerNo | String | 拉卡拉内部商户号 |
| subMchId | String | 账户端子商户号 |
| channelId | String | 渠道号 |
| receOrgNo | String | 从业机构号 |
| applymentId | String | 申请编号 |
| applymentState | String | 申请状态（见下）|
| authorizeState | String | 认证状态：UNAUTHORIZED / AUTHORIZED / CLOSED / SMID_NOT_EXIST |
| registerChannel | String | 报备通道 |
| realNameType | String | 实名认证类型 WXZF / ZFBZF |
| qrcodeData | String | 小程序码链接（部分状态返回）|
| rejectParameter | String | 驳回参数 |
| rejectReason | String | 驳回原因 |

#### applymentState 枚举（支付宝特有）

| Code | 中文 |
|---|---|
| APPLYMENT_STATE_FAIL | 提交失败 |
| APPLYMENT_STATE_COMMIT | 已提交 |
| AUDITING | 支付宝-审核中 |
| CONTACT_CONFIRM | 支付宝-待联系人确认 |
| LEGAL_CONFIRM | 支付宝-待法人确认 |
| AUDIT_PASS | 支付宝-审核通过 |
| AUDIT_REJECT | 支付宝-审核驳回 |
| AUDIT_FREEZE | 支付宝-已冻结 |
| CANCELED | 支付宝-已撤回 |

> qrcodeData 在 CONTACT_CONFIRM / LEGAL_CONFIRM / AUDIT_PASS / AUDIT_FREEZE 时返回。

---

## 16. 支付宝修改提交

- **path**: `/api/v2/mms/openApi/alipayRealName/modifyCommit`
- **测试环境**: `https://test.wsmsd.cn/sit/api/v2/mms/openApi/alipayRealName/modifyCommit`
- **生产环境**: `https://s2.lakala.com/api/v2/mms/openApi/alipayRealName/modifyCommit`

### 请求参数（reqData）

| 字段 | 约束 | 类型 | 长度 | 描述 |
|---|---|---|---|---|
| version | 必传 | String | 8 | 1.0 |
| orderNo | 必传 | String | 32 | 订单编号 |
| orgCode | 必传 | String | 32 | 机构代码 |
| merInnerNo | 必传 | String | 32 | 拉卡拉内部商户号 |
| receOrgNo | 必传 | String | 32 | 受理机构号 |
| subMchId | 必传 | String | 32 | 子商户号 |
| channelId | 必传 | String | 32 | 支付宝的 source |
| applymentId | 选传 | String | 32 | 申请编号（查询返回 ID 时必传，否则按新增实名处理）|

### 响应参数（respData）

| 字段 | 类型 | 描述 |
|---|---|---|
| retCode | String | 返回码 |
| retMsg | String | 返回码描述 |

---

# 数据字典摘录

## D1. 地区码

- 字段名: `merRegDistCode` / `shopDistCode`
- 状态: 拉卡拉以 Excel 附件形式提供（`地区码表NEW.xlsx`），未在文档页内联展示。
- **TODO**: 需在 Phase 1 时从附件下载导入项目数据字典；本项目硬编码湖南张家界区域码即可（`feedback_decision_with_scenario`）。

## D2. 经营内容字典表

字段名: `merBusiContent`

| 编号 | 名称 |
|---|---|
| 640 | 餐饮、宾馆、娱乐、珠宝金饰、工艺美术品 |
| 641 | 房地产汽车类 |
| 642 | 百货、中介、培训、景区门票等 |
| 643 | 批发类商户 |
| 644 | 加油、超市类 |
| 645 | 交通运输售票 |
| 646 | 水电气缴费 |
| 647 | 政府类 |
| 648 | 便民类 |
| 649 | 公立医院、公立学校、慈善 |
| 650 | 宾馆餐饮娱乐类 |
| 651 | 房产汽车类 |
| 652 | 批发类 |
| 653 | 超市加油类 |
| 654 | 一般类商户 |
| 655 | 三农商户 |

总条数：16

> 凤御美容院应选 **640 餐饮、宾馆、娱乐、珠宝金饰、工艺美术品**（含美容/SPA 类 MCC 7298）。

## D3. POS 类型字典表

字段名: `posType`

| POS 类型名称 | POS 类型 | 备注 |
|---|---|---|
| 传统 POS | `GENERAL_POS` | |
| 智能 POS | `SUPER_POS` | |
| 蓝精灵 | `BLUE_WIZARD` | |
| 专业化扫码 | `WECHAT_PAY` | |
| 收钱吧扫码 | `SQB_SCAN_CODE` | |
| 收钱吧码牌 | `SQB_PAPER_CODE` | |
| 收钱吧桌码 | `SQB_DESK_CODE` | |
| 收钱吧 POS | `SQB_POS` | |
| 收钱吧聚分期 | `SQB_INSTALLMENT` | |
| 新云小店 | `CLOUD_STORE_NEW` | 增商专用 |
| 云分销 | `CLOUD_DISTRIBUTION` | |
| 云分销线上 | `CLOUD_DISTRIBUTION_CB` | |
| 云小店线上 | `CLOUD_STORE_CB` | |
| 云小店线下 | `CLOUD_STORE_BC` | |
| 云小店非收银机 | `CLOUD_STORE_BC_NOTLKL` | |
| 惠码 | `HM` | |
| 惠码线上 | `HM_CB` | |
| 惠码线下 | `HM_BC` | |
| 扫码点餐 | `SCAN_CODE_ORDER` | |
| B2B 收银台 | `B2B_CASHIER_DESK` | |
| B2B 收款码 | `B2B_QR_CODE` | |
| 手机 POS | `MOBILE_POS` | |
| 御风云码 | `YF_YM` | |
| 御风云码线上 | `YF_YM_CB` | |
| 大额理财 | `TRANSFER_ACCOUNT` | |
| 超级收款宝 | `SUPER_MPOS` | |
| 收钱宝盒 | `W_BOX` | |
| 月光宝盒 | `MOON_BOSX` | |
| Q 码精灵 | `SCANNING_GUN_PAY` | |
| 智能 POS PRO | `WIDE_SUPER_POS` | |

总条数：>30（截断；本项目固定使用 `WECHAT_PAY` 专业化扫码）

## D4. 业务类型字典表

字段名: `busiTypeCode`

| 名称 | 代码 |
|---|---|
| 银行卡 | `BANK_CARD` |
| 外卡 | `WILD_CARD` |
| 扫码 | `QR_CODE_CARD` |
| 大额理财 | `BIG_AMOUNT_FINANCE` |
| 银行卡网银 | `E_BANK` |

总条数：5

## D5. 结算周期字典表

字段名: `settlePeriod`

| 代码 | 名称 | 划款时间 | 描述 |
|---|---|---|---|
| `T+1` | T+1 结算 | T 日 5:30-9:30 | 4 |
| `T+1+N` | T+1 普通结算批次 | T 日 12:00-15:00 | 78 |
| `T+3` | 收单 T+3 结算 |  | 5 |
| `D+1+N` | D+1 普通结算批次 | T 日 12:00-15:00 | 78 |
| `W_T+9999` | 喔噻 T+9999 不结算批次 | 提款模式 | 25 喔噻专用 |
| `D+1` | 收单 D+1 结算批次 | D 日 05:30 左右 | 18 |
| `D1+24` | D1+24 结算批次 | D 日 11:00 左右 | 58 乐惠专用 |
| `D+30` | 收单 D+30 结算 |  | 91 |
| `BT_D+1` | D+1 四方补贴结算批次 |  | 92 |
| `QZT_FULL_D+1` | 钱账通 D+1 全额结算批次 |  | 85 |
| `QZT_NET_D+1` | 钱账通 D+1 净额结算批次 |  | 88 |
| `FS` | 灵活结算 |  | 当前只限汇拓客使用 |

总条数：12

> 凤御使用 **T+1** 标准结算。

## D6. 证件类型字典表

字段名: `larIdType` / `accIdType`

| 证件类型名称 | 代码 |
|---|---|
| 身份证 | `01` |
| 护照 | `02` |
| 港澳通行证 | `03` |
| 台胞证 | `04` |
| 外国人永久居留身份证 | `10` |
| 港澳居民居住证 | `11` |
| 台湾居民居住证 | `12` |
| 执行事务合伙人 | `13` |
| 其它证件 | `99` |

总条数：9

> **法人/经营者证件类型**字段在电子合同接口（cert_type）中用代码 RESIDENT_ID/PASSPORT/HK_MACAO_PASS/TAIWAN_PASS，与进件接口 larIdType（01/02/03/04）不同，调用时需做映射。

## D7. 限额类型字典表

字段名: `limitTypeCode`

| 类型名称 | 代码 |
|---|---|
| 银行借记卡 | `BANK_DEBIT_CARD` |
| 银行贷记卡 | `BANK_CREDIT_CARD` |
| 扫码 | `QR_CODE_CARD` |
| 外卡 | `WILD_CARD` |
| 联机退货 | `RETURNS_ONLINE` |
| 纸码 | `PAPER_CODE` |

总条数：6

> 费率类型字典表（按用户指示跳过，本项目不展示费率）。

## D8. 商户状态字典表

字段名: `merStatus` / `shopStatus` / `busiStatus`

| 类型名称 | 代码 |
|---|---|
| 有效 | `VALID` |
| 无效 | `INVALID` |

总条数：2

## D9. 错误码表（节选）

### 新增商户进件

| 序号 | Code | 描述 |
|---|---|---|
| 1 | 000000 | 成功 |
| 2 | 100047 | postype 不存在 |
| 3 | 100028 | 账户类型不存在 |
| 4 | 100006 | 参数校验失败 |
| 5 | 100030 | 对公营业执照不可与法人证件相同 |
| 6 | 100029 | 营业执照号码不能为空 |
| 7 | 100031 | 营业执照名称不能为空 |
| 8 | 100032 | 营业执照有效期不能为空 |
| 9 | 100009 | 调用商户进件系统接口异常 |
| 10 | 100001 | 系统异常 |
| 11 | 103070 | 增商进件参数校验失败 |
| 12 | 103001 | 增商进件系统异常 |

### 增网增终进件

| 序号 | Code | 描述 |
|---|---|---|
| 1 | 000000 | 成功 |
| 2 | 100047 | postype 不存在 |
| 3 | 100006 | 参数校验失败 |
| 4 | 100009 | 调用商户进件系统接口异常 |
| 5 | 100010 | 调用核心库系统接口异常 |
| 6 | 100001 | 系统异常 |
| 7 | 103070 | 增终进件参数校验失败 |
| 8 | 103001 | 增终进件系统异常 |
| 9 | 100011 | 内部商户号不存在 |
| 10 | 100048 | 银联商户号不存在 |
| 11 | 100017 | 网点信息不存在 |
| 12 | 100015 | 终端号不存在 |
| 13 | 100016 | 终端信息不存在 |

### 通用补充

| Code | 描述 |
|---|---|
| 000000 | 成功 |
| OP10102 | 三代进件复议提交失败（状态不可复议）|
| 087900 | 三四要素认证失败（可申请转人工复核）|
| 087901 | 手机号实名认证不通过 |

## D10. MCC 对照表（餐娱类摘录）

字段名: `mccCode`

| 大类 | MCC | 商户类别名 |
|---|---|---|
| 餐娱类 | 5094 | 贵重珠宝、首饰、钟表零售 |
| 餐娱类 | 5811 | 包办伙食、宴会承包商 |
| 餐娱类 | 5812 | 就餐场所和餐馆 |
| 餐娱类 | 5813 | 饮酒场所（酒吧、酒馆、夜总会、鸡尾酒大厅、迪斯科舞厅）|
| 餐娱类 | 5932 | 古玩店——出售、维修及还原 |
| 餐娱类 | 5937 | 古玩复制店 |
| 餐娱类 | 5944 | 银器店 |
| 餐娱类 | 5950 | 玻璃器皿和水晶饰品店 |
| 餐娱类 | 5970 | 工艺美术商店 |
| 餐娱类 | 5971 | 艺术商和画廊 |
| 餐娱类 | 7011 | 住宿服务（旅馆、酒店、汽车旅馆、度假村等）|
| 餐娱类 | 7012 | 分时使用的别墅或度假用房 |
| 餐娱类 | 7032 | 运动和娱乐露营地 |
| 餐娱类 | 7033 | 活动房车场及露营场所 |
| 餐娱类 | 7297 | 按摩店 |
| **餐娱类** | **7298** | **保健及美容 SPA** ← 凤御推荐 |
| 餐娱类 | 7631 | 手表、钟表和首饰维修店 |
| 餐娱类 | 7829 | 电影和录像创作、发行 |
| 餐娱类 | 7911 | 歌舞厅 |
| 餐娱类 | 7922 | 戏剧制片（不含电影）、演出和票务 |
| 餐娱类 | 7929 | 未列入其他代码的乐队、文艺表演 |
| 餐娱类 | 7932 | 台球、撞球场所 |
| 餐娱类 | 7933 | 保龄球馆 |
| 餐娱类 | 7941 | 商业体育场馆、职业体育俱乐部、运动场和体育推广公司 |
| 餐娱类 | 7992 | 公共高尔夫球场 |
| 餐娱类 | 7994 | 大型游戏机和游戏场所 |
| 餐娱类 | 7996 | 游乐园、马戏团、嘉年华、占卜 |
| 餐娱类 | 7997 | 会员俱乐部（体育、娱乐、运动等）、乡村俱乐部、私人高尔夫课程班 |
| 餐娱类 | 7998 | 水族馆、海洋馆和海豚馆 |
| 餐娱类 | 7999 | 未列入其他代码的娱乐服务 |

总条数：>30（截断；完整表含房产汽车/百货/批发/超市/三农等多个大类）。

## D11. 设备型号字典表

字段名: `devTypeName`

| 代码（设备型号） | posType（适配的 posType）|
|---|---|
| 智能 POS、传统 POS | 收钱吧 POS |
| 扫码王、收钱吧 APP、合作厂商扫码机、合作厂商 APP、收钱吧插件、合作厂商插件、零售自助付款设备、服务自助付款设备 | 收钱吧扫码 |
| 收款码牌 | 收钱吧码牌 |
| 桌贴码 | 收钱吧桌码 |

总条数：4

---

# 14 步流程图与接口映射

> 凤御接入拉卡拉商户入网的标准 14 步流程。"用户视角"指 admin / 运维人员（凤御方）应当调用哪个接口或等待哪个回调。

| 步骤 | 用户视角操作 | 调用方向 | 接口 / 章节 | 输入关键字段 | 输出关键字段 |
|---|---|---|---|---|---|
| 1 | 准备进件资料（法人/营业执照/结算卡） | - | （仅录入，不调用拉卡拉）| 资料 + 附件文件 | 持久化进 PG |
| 2 | 上传法人身份证正/反面 | 凤御 → 拉卡拉 | §5 附件上传 ×2 | attType=FR_ID_CARD_FRONT/FR_ID_CARD_BEHIND | attFileId |
| 3 | 上传银行卡 / 营业执照 / 门头照 / 内景照 | 凤御 → 拉卡拉 | §5 附件上传 ×N | attType=BANK_CARD/BUSINESS_LICENCE/MERCHANT_PHOTO/SHOPINNER | attFileId |
| 4 | 申请电子合同 | 凤御 → 拉卡拉 | §2 电子合同申请 | ec_type_code=EC015，cert_*, 结算卡，ec_content_parameters | ec_apply_id, result_url（H5 签约链接）|
| 5 | 法人收到短信，在 H5 完成签署 | 法人手机 | （拉卡拉 H5）| - | - |
| 6 | 异步通知签约完成 | 拉卡拉 → 凤御 | §2 异步签约结果通知 | ecApplyId, ecStatus=COMPLETED, ecNo | 落库 ecNo |
| 7 | 主动查询合同状态兜底 | 凤御 → 拉卡拉 | §3 电子合同查询 | ec_apply_id | ec_status, ec_no |
| 8 | （可选）下载合同 PDF 留档 | 凤御 → 拉卡拉 | §4 电子合同下载 | ec_apply_id | ec_file（base64 URL-safe）|
| 9 | 提交商户进件（含 ecNo） | 凤御 → 拉卡拉 | §6 新增商户进件 | 全量商户/结算/法人/网点信息 + feeData + fileData + contractNo=ecNo | contractId |
| 10 | 异步接收进件审核结果 | 拉卡拉 → 凤御 | §8 进件回调通知 | contractStatus, merInnerNo, merCupNo, termDatas[].termNo+activeNo | 落库 merInnerNo / termNo |
| 11 | 主动查询进件状态兜底 | 凤御 → 拉卡拉 | §7 进件信息查询 | contractId | 同回调字段 |
| 12 | （驳回时）提交复议转人工 | 凤御 → 拉卡拉 | §9 进件复议提交 | contractId | 受理回执 |
| 13 | 查询微信报备状态 | 凤御 → 拉卡拉 | §13 微信实名认证结果查询 + §12 支付宝微信开户状态查询 | merInnerNo, channelId | applymentState, authorizeState, qrcodeData |
| 13b | （未完成时）发起 / 修改微信实名 | 凤御 → 拉卡拉 | §14 微信实名修改提交 | applymentId（已有则改，缺省按新增）| 受理回执 |
| 14 | 查询支付宝报备状态 + 综合报备结果 | 凤御 → 拉卡拉 | §15 支付宝实名查询 + §10 商户报备结果查询 | merInnerNo / subMchId | applymentState, registerStatus, qrcodeData |
| 14b | （未完成时）发起 / 修改支付宝实名 | 凤御 → 拉卡拉 | §16 支付宝修改提交 | applymentId | 受理回执 |
| 14c | （变更资料时）商户信息变更 | 凤御 → 拉卡拉 | §11 商户信息变更 | merInnerNo + 变更字段 + retUrl | contractId（变更单）|

### 状态机说明

- **电子合同**: UNDONE → COMPLETED
- **进件**: NO_COMMIT → COMMIT → REVIEW_ING → (WAIT_FOR_CONTACT 通过 | INNER_CHECK_REJECTED 驳回 → 复议 → MANUAL_AUDIT → WAIT_FOR_CONTACT)
- **微信实名**: 提交 → APPLYMENT_STATE_WAITTING_FOR_AUDIT → WAITTING_FOR_CONFIRM_CONTACT → WAITTING_FOR_CONFIRM_LEGALPERSON → APPLYMENT_STATE_PASSED → AUTHORIZE_STATE_AUTHORIZED
- **支付宝实名**: 提交 → AUDITING → CONTACT_CONFIRM → LEGAL_CONFIRM → AUDIT_PASS → AUTHORIZED
- **综合报备**: SUCCESS / FAIL（按 registerChannel × registerType 多条并存）

### 异步回调签名验证

接入方（凤御 admin）需在回调 route（Phase 1C）中：

1. 从 Header `Authorization` 解出 timestamp / nonce_str / signature
2. 用拉卡拉公钥按 `${timeStamp}\n${nonceStr}\n${body}\n` 拼串
3. SHA256withRSA 验签
4. 返回 `{"code":"SUCCESS","message":"成功"}` ACK

---

# Phase 1-3 关注点

| Phase | 关注 | 关联章节 |
|---|---|---|
| 1A DB schema | merchant 主表 + applyment 进件单 + ec_contract 合同 + attachment 附件 + status_history 状态机 + 脱敏字段 | §2 §6 §7 §8 |
| 1B lakala-client 16 方法 | 16 个 SDK 方法 + 字典 const + 费率 helper（简化，不暴露 feeData）| 全部 |
| 1C 回调 + cron 兜底 | route /api/lakala/onboarding/callback + 进件/合同/微信/支付宝状态查询 cron | §3 §7 §8 §13 §15 |
| 2D Server Actions + e2e | 14 步流程的 actions + smoke 测试 | §2-§16 |
| 2E UI 6 页 + StepProgress | 6 页 form + 14 步状态条 + 菜单 + 权限 + 守护测试 | 流程图 |
| 3F 集成验收 + changedoc | arch/007 落库 | - |

---

# 抓取 TODO 清单

- ✅ §1-§16 16 个接口全部成功抓取
- ✅ 11 个数据字典: 经营内容(D2) / POS 类型(D3) / 业务类型(D4) / 结算周期(D5) / 证件类型(D6) / 限额类型(D7) / 商户状态(D8) / 错误码(D9) / MCC(D10) / 设备型号(D11) 全部抓取完成
- ⚠️ **D1 地区码**: 拉卡拉以 `地区码表NEW.xlsx` 附件形式提供，未在页面内联展示。Phase 1 需从附件下载或本项目硬编码（凤御位于湖南张家界，区域码相对固定）。
- ⚠️ **费率类型字典表**: 用户明确跳过（本项目不展示费率）。
- ⚠️ **日切时间字典表**: 进件 / 变更接口字段 `clearDt` 引用此字典；当前默认 TWENTY_THREE 即可，详细枚举可后续补充。
- ⚠️ **MCC 对照表**: 仅摘录餐娱类 30 行；完整表含房产汽车 / 百货 / 批发等多个大类。凤御只需关注 **7298 保健及美容 SPA** 一行。
