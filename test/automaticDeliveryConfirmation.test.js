"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { evaluateAutomaticDeliveryConfirmation: check } = require("../services/automaticDeliveryConfirmation");

const now = new Date("2026-11-09T12:00:00.000Z");
const base = {
  orderStatus: "delivered", paymentStatus: "success",
  hasRefundOrDispute: false, buyerReportedNotReceived: false,
  buyerConfirmedAt: null, proofSource: "verified_courier",
  proofVerified: true, verifiedDeliveredAt: "2026-11-07T11:59:59.000Z",
};

test("verified delivery older than 48 hours qualifies for auto-confirmation review", () => {
  const result = check(base, now);
  assert.equal(result.eligible, true);
  assert.equal(result.sellerProtectionEndsAt, "2026-11-14T11:59:59.000Z");
});
test("seller-reported delivery cannot trigger auto-confirmation", () => {
  assert.equal(check({...base, proofSource: "seller_reported"}, now).eligible, false);
});
test("late delivery does not start the clock from estimated date", () => {
  assert.equal(check({...base, verifiedDeliveredAt: "2026-11-09T11:00:00.000Z"}, now).eligible, false);
});
test("dispute and missing parcel block auto-confirmation", () => {
  assert.equal(check({...base, hasRefundOrDispute: true}, now).eligible, false);
  assert.equal(check({...base, buyerReportedNotReceived: true}, now).eligible, false);
});
test("payment and future timestamps are checked", () => {
  assert.equal(check({...base, paymentStatus: "pending"}, now).eligible, false);
  assert.equal(check({...base, verifiedDeliveredAt: "2026-11-10T00:00:00Z"}, now).eligible, false);
});
