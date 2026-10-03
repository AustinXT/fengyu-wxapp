// 为cover-window视图验收提供真实product路由和完整迁移私有PG；订单只验证前端合成明细。
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
const require=createRequire(import.meta.url)
export async function startCoverWindowPgFixture(connectionString) {
  const target=new URL(connectionString)
  assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,'54416');assert.equal(target.pathname,'/issue256cireplay')
  const {Client}=require('../../../db/node_modules/pg')
  const client=new Client({connectionString});await client.connect();await client.query('BEGIN')
  const tag='COVER273';const pg=require('../../cloudfunctions/clientApi/db/pg.js');const original=pg.query
  try {
    await client.query(`INSERT INTO product_categories(category_id,category_name) VALUES('COVER273-C','合成分类');
      INSERT INTO mall_categories(category_id,category_name) VALUES('COVER273-M','合成商城分类');
      INSERT INTO products(product_id,category_id,name,price,cover_image) VALUES('COVER273-P','COVER273-M','合成体验卡',100,'https://6665-fengyu-client-prod-d1cga6909c0ba-1406056527.tcb.qcloud.la/product-covers/cover273.png');
      INSERT INTO product_skus(sku_id,category_id,product_type,spec_name,price,session_count,is_experience,market_scope,sort_order)
        SELECT 'COVER273-S'||lpad(i::text,4,'0'),'COVER273-C','疗程卡','合成规格',100,1,true,'COVER273',i/3 FROM generate_series(0,199) i;
      INSERT INTO mall_product_skus(product_id,sku_id) SELECT 'COVER273-P',sku_id FROM product_skus WHERE sku_id LIKE 'COVER273-S%';
      INSERT INTO product_skus(sku_id,category_id,product_type,spec_name,price,session_count,is_experience,market_scope)
        VALUES('COVER273-hidden','COVER273-C','疗程卡','不可见',100,1,true,'other'),('COVER273-empty','COVER273-C','疗程卡','空市场',100,1,true,'');`)
    pg.query=async (sql,params)=>(await client.query(sql,params)).rows
    const route=require('../../cloudfunctions/clientApi/routes/product.js')
    const noScope={auth:null,event:{payload:{limit:20}}};await route.experienceCardList(noScope);assert.equal(noScope.result.skuList.length,0)
    return { invoke: async(payload)=>{
      const ctx={auth:{boundMarketName:tag},event:{payload}};await route.experienceCardList(ctx)
      assert(ctx.result.skuList.every(row=>row.sku_id.startsWith('COVER273-S') && row.cover_image?.includes('imageMogr2')))
      return {result:{code:0,message:'success',data:ctx.result}}
    },close:async()=>{pg.query=original;await client.query('ROLLBACK');await client.end()} }
  }catch(error){pg.query=original;await client.query('ROLLBACK');await client.end();throw error}
}
