"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {verifyLegacyAmount}=require("../services/verifyLegacyAllocation");
const base=()=>({
  seller_net_minor:null,allocation_status:"pending_review",payment_status:"success",
  payment_currency:"NGN",payment_buyer_id:1,buyer_id:1,paid_order_id:2,order_id:2,
  seller_count:1,seller_id:3,currency:"USD",gross_minor:"10000",commission_minor:"0",
  payment_amount:"150000.00",order_total_amount:"100.00",
  checkout_snapshot:{schema_version:1,order_currency:"USD",order_total_minor:10000,
    expected_kobo:15000000,items:[{product_id:9,seller_id:3,quantity:2,unit_price_minor:5000}]}
});
const lines=()=>[{product_id:9,quantity:2,price:"50.00"}];
test("legacy amount reconciles only verified original checkout",()=>{
  assert.deepEqual(verifyLegacyAmount(base(),lines()),{
    ok:true,gross_minor:"10000",commission_minor:"600",seller_net_minor:"9400"
  });
});
test("rejects unverified, changed or unsupported original records",()=>{
  const scenarios=[
    r=>{r.checkout_snapshot=null;},
    r=>{r.checkout_snapshot.items[0].seller_id=4;},
    r=>{r.checkout_snapshot.items[0].unit_price_minor=4500;},
    r=>{r.payment_amount="149999.99";},
    r=>{r.order_total_amount="99.00";},
    r=>{r.seller_count=2;},
    r=>{r.payment_status="pending";},
    r=>{r.paid_order_id=5;},
    r=>{r.seller_net_minor="9400";},
    r=>{r.commission_minor="100";},
    r=>{r.currency="NGN";},
  ];
  for(const mutate of scenarios){const r=base();mutate(r);assert.equal(verifyLegacyAmount(r,lines()).ok,false);}
  assert.equal(verifyLegacyAmount(base(),[{product_id:9,quantity:2,price:"49.99"}]).ok,false);
});

test("identifies each failed payment or ownership check without restoring a balance",()=>{
  const checks=[
    [r=>{r.allocation_status="blocked";},/allocation is blocked or closed/i],
    [r=>{r.payment_status="pending";},/payment is not marked successful/i],
    [r=>{r.payment_currency="USD";},/unsupported legacy currency/i],
    [r=>{r.payment_buyer_id=5;},/different buyer/i],
    [r=>{r.paid_order_id=null;},/not linked to this order/i],
    [r=>{r.seller_count=2;},/multiple or missing seller allocations/i],
  ];
  for(const [mutate,reason] of checks){
    const record=base();
    mutate(record);
    const result=verifyLegacyAmount(record,lines());
    assert.equal(result.ok,false);
    assert.match(result.reason,reason);
    assert.equal(record.seller_net_minor,null);
  }
});
