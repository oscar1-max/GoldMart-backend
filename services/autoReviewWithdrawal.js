"use strict";

// Offline, deterministic risk review: NO external AI model, NO transfers.
// Only independently buyer-confirmed delivered orders can auto-approve,
// and only after a seven-day cooling-off period.
const REVIEW_DAYS = 7;
const REVIEW_MS = REVIEW_DAYS * 24 * 60 * 60 * 1000;

function positiveMinor(value) {
  if (!/^[1-9]\d{0,14}$/.test(String(value ?? ""))) return null;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function evaluateWithdrawal(details, now = new Date()) {
  const pending = (reason) => ({
    status: "pending_review",
    reason,
    decision_source: "automatic_rules",
  });
  if (!details) return pending("Seller allocation is missing.");
  const amount = positiveMinor(details.seller_net_minor);
  const gross = positiveMinor(details.gross_minor);
  const commission = Number(details.commission_minor);
  if (!amount || !gross || !Number.isSafeInteger(commission) ||
      commission < 0 || gross !== amount + commission) {
    return pending("Seller amount needs manual review.");
  }
  if (!["USD", "NGN"].includes(String(details.currency || "").toUpperCase())) {
    return pending("Unsupported currency.");
  }
  if (details.payment_status !== "success" ||
      !["pending_review", "eligible"].includes(details.allocation_status)) {
    return pending("Payment or allocation is not eligible.");
  }
  if (Number(details.seller_count) !== 1) {
    return pending("Multi-seller orders require separate fulfillment review.");
  }
  if (Number(details.payment_buyer_id) !== Number(details.buyer_id) ||
      Number(details.paid_order_id) !== Number(details.order_id)) {
    return pending("Payment and order ownership need review.");
  }
  if (details.order_status !== "delivered") {
    return pending("Order has not been delivered.");
  }
  if (Number(details.buyer_id) === Number(details.seller_id)) {
    return pending("Buyer and seller accounts need review.");
  }
  if (details.seller_is_banned === true) {
    return pending("Seller account needs review.");
  }
  if (Number(details.refund_count) !== 0) {
    return pending("A refund or cancellation request needs review.");
  }
  if (!details.buyer_confirmed_at ||
      Number(details.confirmed_buyer_id) !== Number(details.buyer_id)) {
    return pending("Buyer has not independently confirmed delivery.");
  }
  const when = new Date(details.buyer_confirmed_at).getTime();
  if (!Number.isFinite(when) || !Number.isFinite(now.getTime()) ||
      when > now.getTime() || now.getTime() - when < REVIEW_MS) {
    return pending("Seven-day buyer-confirmation review period is not complete.");
  }
  return {
    status: "approved_test",
    reason: "Verified test payment, buyer-confirmed delivery, no refund and review period passed.",
    decision_source: "automatic_rules",
  };
}

module.exports = { evaluateWithdrawal, positiveMinor, REVIEW_DAYS };
