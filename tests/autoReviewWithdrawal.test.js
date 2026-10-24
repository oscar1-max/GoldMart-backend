"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateWithdrawal, positiveMinor, REVIEW_DAYS } = require("../services/autoReviewWithdrawal");

const NOW = new Date("2026-10-24T12:00:00.000Z");
function safe(overrides = {}) {
  return {
    seller_net_minor: "9400", gross_minor: "10000", commission_minor: "600",
    currency: "USD", payment_status: "success", allocation_status: "pending_review",
    seller_count: 1, payment_buyer_id: 17, buyer_id: 17,
    paid_order_id: 45, order_id: 45, order_status: "delivered",
    seller_id: 31, seller_is_banned: false, refund_count: 0,
    buyer_confirmed_at: "2026-10-16T12:00:00.000Z", confirmed_buyer_id: 17,
    ...overrides,
  };
}
function pending(details) {
  const result = evaluateWithdrawal(details, NOW);
  assert.equal(result.status, "pending_review", result.reason);
  assert.equal(result.decision_source, "automatic_rules");
}
test("safe delivered and confirmed payment approves simulation only", () => {
  assert.equal(REVIEW_DAYS, 7);
  const result = evaluateWithdrawal(safe(), NOW);
  assert.equal(result.status, "approved_test");
  assert.equal(result.decision_source, "automatic_rules");
});
test("no allocation and invalid amounts cannot approve", () => {
  pending(null);
  pending(safe({ seller_net_minor: "-1" }));
  pending(safe({ seller_net_minor: "0" }));
  pending(safe({ seller_net_minor: "1.23" }));
  pending(safe({ gross_minor: "9000" }));
  pending(safe({ commission_minor: "bad" }));
  assert.equal(positiveMinor("9999999999999999"), null);
});
test("invalid currency, payment and allocation cannot approve", () => {
  pending(safe({ currency: "GBP" }));
  pending(safe({ payment_status: "pending" }));
  pending(safe({ allocation_status: "blocked" }));
  pending(safe({ allocation_status: "settled" }));
});
test("payment ownership, order ownership and multi-seller need review", () => {
  pending(safe({ seller_count: 2 }));
  pending(safe({ payment_buyer_id: 999 }));
  pending(safe({ paid_order_id: 999 }));
});
test("seller cannot self-purchase or use banned account", () => {
  pending(safe({ seller_id: 17 }));
  pending(safe({ seller_is_banned: true }));
});
test("undelivered or disputed orders stay pending", () => {
  pending(safe({ order_status: "shipped" }));
  pending(safe({ refund_count: 1 }));
});
test("buyer confirmation must exist and belong to buyer", () => {
  pending(safe({ buyer_confirmed_at: null }));
  pending(safe({ confirmed_buyer_id: 999 }));
});
test("seven-day waiting period is enforced at boundary", () => {
  pending(safe({ buyer_confirmed_at: "2026-10-17T12:00:01.000Z" }));
  pending(safe({ buyer_confirmed_at: "2026-10-25T12:00:00.000Z" }));
  pending(safe({ buyer_confirmed_at: "not-a-date" }));
  assert.equal(evaluateWithdrawal(safe({ buyer_confirmed_at: "2026-10-17T12:00:00.000Z" }), NOW).status, "approved_test");
});
