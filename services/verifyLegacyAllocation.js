"use strict";

// Repair only legacy TEST allocation amounts with an original, internally
// consistent paid checkout snapshot. Never estimate amounts from today's
// product prices, manually entered balances or seller-provided values.
const { positiveMinor } = require("./autoReviewWithdrawal");

function minorFromDecimal(value) {
  const match = new RegExp("^(0|[1-9][0-9]*)(?:[.]([0-9]{1,2}))?$").exec(String(value ?? ""));
  if (!match) return null;
  const amount = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  return Number.isSafeInteger(amount) ? amount : null;
}

function verifyLegacyAmount(row, orderItems) {
  const fail = reason => ({ ok: false, reason });
  if (!row || (row.seller_net_minor !== null && row.seller_net_minor !== undefined)) {
    return fail("Only legacy allocations with a missing seller amount can be repaired.");
  }
  // Return the first failed check to the allocation owner. This is a
  // read-only diagnosis; never relax the original payment safety rules.
  if (!["pending_review", "eligible"].includes(row.allocation_status)) {
    return fail("This allocation is blocked or closed. Admin must review its status.");
  }
  if (row.payment_status !== "success") {
    return fail("The original payment is not marked successful. Admin must verify the payment with the provider.");
  }
  if (row.payment_currency !== "NGN") {
    return fail("The original payment uses an unsupported legacy currency. Admin must review the original payment evidence.");
  }
  if (Number(row.payment_buyer_id) !== Number(row.buyer_id)) {
    return fail("The payment belongs to a different buyer than this order. Admin must review ownership.");
  }
  if (Number(row.paid_order_id) !== Number(row.order_id)) {
    return fail("The original payment is not linked to this order. Admin must review the payment link.");
  }
  if (Number(row.seller_count) !== 1) {
    return fail("This order has multiple or missing seller allocations. Admin must review the allocation records.");
  }
  const snapshot = row.checkout_snapshot;
  if (!snapshot || snapshot.schema_version !== 1 ||
      !Array.isArray(snapshot.items) || !snapshot.items.length) {
    return fail("This older payment has no verified checkout snapshot. The amount needs manual admin review.");
  }
  const currency = String(row.currency || "").toUpperCase();
  const gross = positiveMinor(row.gross_minor);
  const expected = positiveMinor(snapshot.expected_kobo);
  const total = positiveMinor(snapshot.order_total_minor);
  if (!["USD", "NGN"].includes(currency) || snapshot.order_currency !== currency ||
      !gross || !total || gross !== total || !expected ||
      minorFromDecimal(row.payment_amount) !== expected ||
      minorFromDecimal(row.order_total_amount) !== total) {
    return fail("The original payment and order totals do not match.");
  }
  if (row.withdrawal_id != null) {
    return fail("An existing withdrawal request requires manual review.");
  }
  const sellerId = Number(row.seller_id);
  const seen = new Set();
  const lines = new Map();
  let sum = 0;
  for (const item of snapshot.items) {
    const id = Number(item?.product_id);
    const quantity = positiveMinor(item?.quantity);
    const price = positiveMinor(item?.unit_price_minor);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id) ||
        Number(item?.seller_id) !== sellerId || !quantity || !price) {
      return fail("Original checkout items need manual review.");
    }
    const line = quantity * price;
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(sum + line)) {
      return fail("Original checkout amount is outside the safe range.");
    }
    seen.add(id);
    lines.set(id, { quantity, price });
    sum += line;
  }
  if (sum !== gross || !Array.isArray(orderItems) || orderItems.length !== lines.size) {
    return fail("Original order items do not match the paid checkout.");
  }
  const verified = new Set();
  for (const item of orderItems) {
    const id = Number(item.product_id);
    const expectedLine = lines.get(id);
    if (!expectedLine || verified.has(id) ||
        Number(item.quantity) !== expectedLine.quantity ||
        minorFromDecimal(item.price) !== expectedLine.price) {
      return fail("Saved order items differ from the original checkout.");
    }
    verified.add(id);
  }
  const commission = Math.round(gross * 6 / 100);
  const recordedCommission = Number(row.commission_minor);
  const net = gross - commission;
  if (!Number.isSafeInteger(commission) || !Number.isSafeInteger(net) ||
      net <= 0 || ![0, commission].includes(recordedCommission)) {
    return fail("Recorded commission requires manual review.");
  }
  return { ok: true, gross_minor: String(gross), commission_minor: String(commission),
    seller_net_minor: String(net) };
}

module.exports = { verifyLegacyAmount, minorFromDecimal };
