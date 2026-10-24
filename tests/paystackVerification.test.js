"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { matchesVerifiedPayment } = require("../utils/paystackPaymentValidation");

function sample() {
  const payment = {
    user_id: 17,
    reference: "GM-12345-ABCDE",
    amount: "15000.00",
    currency: "NGN",
    checkout_snapshot: {
      schema_version: 1,
      order_currency: "USD",
      order_total_minor: 1000,
      expected_kobo: 1500000,
      items: [{ product_id: 1, seller_id: 8, quantity: 2, unit_price_minor: 500 }],
    },
  };
  const transaction = {
    status: "success",
    domain: "test",
    reference: payment.reference,
    amount: 1500000,
    currency: "NGN",
    metadata: {
      goldmart_reference: payment.reference,
      goldmart_user_id: 17,
      goldmart_order_currency: "USD",
      goldmart_order_total_minor: 1000,
    },
  };
  return { payment, transaction };
}

test("accepts a correctly verified test charge", () => {
  const { payment, transaction } = sample();
  assert.equal(matchesVerifiedPayment(transaction, payment), true);
});

test("rejects wrong amount, stored amount, currency, reference and live charges", () => {
  for (const change of [
    ({ transaction }) => { transaction.amount -= 100; },
    ({ payment }) => { payment.amount = "14000.00"; },
    ({ transaction }) => { transaction.currency = "USD"; },
    ({ transaction }) => { transaction.reference = "GM-OTHER"; },
    ({ transaction }) => { transaction.domain = "live"; },
  ]) {
    const data = sample();
    change(data);
    assert.equal(matchesVerifiedPayment(data.transaction, data.payment), false);
  }
});

test("rejects mismatched customer and cart metadata", () => {
  for (const [key, value] of [
    ["goldmart_reference", "GM-OTHER"],
    ["goldmart_user_id", 1],
    ["goldmart_order_currency", "NGN"],
    ["goldmart_order_total_minor", 900],
  ]) {
    const { payment, transaction } = sample();
    transaction.metadata[key] = value;
    assert.equal(matchesVerifiedPayment(transaction, payment), false, key);
  }
});

test("rejects a missing seller, duplicate products or incorrect cart total", () => {
  for (const change of [
    ({ payment }) => { payment.checkout_snapshot.items[0].seller_id = null; },
    ({ payment }) => { payment.checkout_snapshot.items.push({ ...payment.checkout_snapshot.items[0] }); },
    ({ payment }) => { payment.checkout_snapshot.items[0].quantity = 3; },
  ]) {
    const data = sample();
    change(data);
    assert.equal(matchesVerifiedPayment(data.transaction, data.payment), false);
  }
});

test("rejects a missing snapshot or incomplete metadata", () => {
  const a = sample();
  a.payment.checkout_snapshot = null;
  assert.equal(matchesVerifiedPayment(a.transaction, a.payment), false);
  const b = sample();
  b.transaction.metadata = null;
  assert.equal(matchesVerifiedPayment(b.transaction, b.payment), false);
});
