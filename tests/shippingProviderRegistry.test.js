"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {providerOptions,assessRoute,assessCartDelivery}=require("../utils/shippingProviderRegistry");
test("provider candidates are only planning entries",()=>{
 for(const country of ["NG","GB","US","GH","CA","DE","FR","KE","ZA"]){
  assert.ok(providerOptions(country).length);
  for(const p of providerOptions(country)){
   assert.equal(p.connected,false);assert.equal(p.coverage_verified,false);
   assert.equal(p.bookings_enabled,false);assert.equal(p.rates_enabled,false);
  }
 }
 assert.deepEqual(providerOptions("ZZ"),[]);
});
test("only aligned Nigerian domestic routes allow existing test checkout",()=>{
 const sellers=[{seller_id:2,country_code:"NG",pickup_country:"Nigeria"}];
 const allowed=assessCartDelivery(sellers,"Nigeria");
 assert.equal(allowed.status,"nigeria_test_only");
 assert.equal(allowed.test_checkout_allowed,true);
 assert.equal(allowed.shipping_checkout_enabled,false);
 assert.equal(allowed.shipping_quote_available,false);
 for(const [origin,pickup,destination] of [
  ["NG","Nigeria","Ghana"],["GB","United Kingdom","United Kingdom"],
  ["US","USA","Nigeria"],["NG","United Kingdom","Nigeria"],
  [null,null,"Nigeria"],["NG",null,"Nigeria"]
 ]){
  const result=assessCartDelivery([{seller_id:2,country_code:origin,pickup_country:pickup}],destination);
  assert.equal(result.test_checkout_allowed,false);
  assert.equal(result.courier_bookings_enabled,false);
  assert.equal(result.international_payouts_enabled,false);
 }
 assert.equal(assessCartDelivery(sellers,"Unknownland").test_checkout_allowed,false);
 assert.equal(assessCartDelivery([],"Nigeria").test_checkout_allowed,false);
 assert.equal(assessCartDelivery([...sellers,{seller_id:3,country_code:"GB",pickup_country:"UK"}],"Nigeria").test_checkout_allowed,false);
});
