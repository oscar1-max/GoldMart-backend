"use strict";

// Shared, test-only Paystack transaction checks.
// A webhook must ALSO have a valid Paystack HMAC signature before calling this.
function positiveInteger(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function storedAmountInKobo(value) {
  const text = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fractional = ""] = text.split(".");
  const kobo = Number(whole) * 100 + Number(fractional.padEnd(2, "0"));
  return positiveInteger(kobo);
}

function validCartSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return false;
  }
  if (snapshot.schema_version !== 1) return false;
  if (!["NGN", "USD"].includes(snapshot.order_currency)) return false;

  const total = positiveInteger(snapshot.order_total_minor);
  const expectedKobo = positiveInteger(snapshot.expected_kobo);
  if (!total || !expectedKobo || !Array.isArray(snapshot.items) ||
      snapshot.items.length === 0) return false;

  let sum = 0;
  const products = new Set();
  for (const item of snapshot.items) {
    const productId = positiveInteger(item?.product_id);
    const sellerId = positiveInteger(item?.seller_id);
    const quantity = positiveInteger(item?.quantity);
    const unitPrice = positiveInteger(item?.unit_price_minor);

    if (!productId || !sellerId || !quantity || !unitPrice ||
        products.has(productId)) return false;

    const lineTotal = quantity * unitPrice;
    if (!Number.isSafeInteger(lineTotal)) return false;
    sum += lineTotal;
    if (!Number.isSafeInteger(sum)) return false;
    products.add(productId);
  }
  return sum === total;
}

function matchesVerifiedPayment(transaction, payment) {
  if (!transaction || !payment || !validCartSnapshot(payment.checkout_snapshot)) {
    return false;
  }

  const snapshot = payment.checkout_snapshot;
  const metadata = transaction.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }

  const expectedKobo = positiveInteger(snapshot.expected_kobo);
  const paidKobo = positiveInteger(transaction.amount);
  const storedKobo = storedAmountInKobo(payment.amount);
  const buyerId = positiveInteger(payment.user_id);
  const orderTotalMinor = positiveInteger(snapshot.order_total_minor);

  return Boolean(
    expectedKobo && paidKobo && storedKobo && buyerId && orderTotalMinor &&
    transaction.status === "success" &&
    transaction.domain === "test" && // keep real charges disabled
    transaction.reference === payment.reference &&
    String(transaction.currency || "").toUpperCase() === "NGN" &&
    String(payment.currency || "").toUpperCase() === "NGN" &&
    paidKobo === expectedKobo &&
    storedKobo === expectedKobo &&
    metadata.goldmart_reference === payment.reference &&
    Number(metadata.goldmart_user_id) === buyerId &&
    metadata.goldmart_order_currency === snapshot.order_currency &&
    Number(metadata.goldmart_order_total_minor) === orderTotalMinor
  );
}

module.exports = { matchesVerifiedPayment, validCartSnapshot };
