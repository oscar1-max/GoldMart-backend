"use strict";

// Used by both the signed Paystack webhook and the buyer confirmation endpoints.
// Caller MUST start a SQL transaction and lock the payments row FOR UPDATE.
// This function never calls COMMIT/ROLLBACK; all effects remain atomic.

class OrderNeedsReviewError extends Error {
  constructor(message) {
    super(message);
    this.name = "OrderNeedsReviewError";
  }
}

function positiveId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

async function finalizePaidOrder(client, payment) {
  if (!client || !payment) {
    throw new Error("A locked payment and database client are required.");
  }
  const buyerId = positiveId(payment.user_id);
  const paymentId = positiveId(payment.id);
  if (!buyerId || !paymentId) {
    throw new OrderNeedsReviewError("Invalid buyer or payment.");
  }

  // Idempotency: one payment can only be attached to one order.
  if (payment.order_id) {
    const result = await client.query(
      "SELECT id, user_id, total_amount, status, created_at FROM orders WHERE id = $1 AND user_id = $2",
      [payment.order_id, buyerId]
    );
    if (!result.rows.length) {
      throw new OrderNeedsReviewError("Payment has an invalid existing order.");
    }
    return { order: result.rows[0], alreadyExists: true };
  }

  if (payment.status !== "success") {
    throw new OrderNeedsReviewError("Only confirmed payments can create orders.");
  }

  const snapshot = payment.checkout_snapshot;
  if (!snapshot || snapshot.schema_version !== 1 ||
      !Array.isArray(snapshot.items) || snapshot.items.length === 0) {
    throw new OrderNeedsReviewError("Payment checkout snapshot is invalid.");
  }

  const orderCurrency = String(snapshot.order_currency || "").toUpperCase();
  const totalMinor = positiveId(snapshot.order_total_minor);
  const expectedKobo = positiveId(snapshot.expected_kobo);
  const paidKobo = Math.round(Number(payment.amount) * 100);

  if (!["USD", "NGN"].includes(orderCurrency) || !totalMinor ||
      !expectedKobo || !Number.isSafeInteger(paidKobo) ||
      paidKobo !== expectedKobo ||
      String(payment.currency || "").toUpperCase() !== "NGN") {
    throw new OrderNeedsReviewError("Payment amount or currency mismatch.");
  }

  const delivery = snapshot.delivery;
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
    throw new OrderNeedsReviewError("Delivery address is missing.");
  }

  const items = [];
  const productIds = new Set();
  const sellerTotals = new Map();
  let computedMinor = 0;

  for (const entry of snapshot.items) {
    const id = positiveId(entry?.product_id);
    const sellerId = positiveId(entry?.seller_id);
    const quantity = positiveId(entry?.quantity);
    const unitPriceMinor = positiveId(entry?.unit_price_minor);

    if (!id || !sellerId || !quantity || !unitPriceMinor ||
        productIds.has(id)) {
      throw new OrderNeedsReviewError("Payment contains invalid items.");
    }

    const lineMinor = quantity * unitPriceMinor;
    const nextTotal = computedMinor + lineMinor;
    const sellerTotal = (sellerTotals.get(sellerId) || 0) + lineMinor;

    if (!Number.isSafeInteger(lineMinor) || !Number.isSafeInteger(nextTotal) ||
        !Number.isSafeInteger(sellerTotal) || lineMinor <= 0) {
      throw new OrderNeedsReviewError("Payment item total is invalid.");
    }

    computedMinor = nextTotal;
    sellerTotals.set(sellerId, sellerTotal);
    productIds.add(id);
    items.push({ id, sellerId, quantity, unitPriceMinor });
  }

  if (computedMinor !== totalMinor) {
    throw new OrderNeedsReviewError("Payment item totals do not match.");
  }

  // Lock product rows in a consistent order to avoid double selling stock.
  for (const item of [...items].sort((a, b) => a.id - b.id)) {
    const productResult = await client.query(
      "SELECT id, stock, seller_id FROM products WHERE id = $1 FOR UPDATE",
      [item.id]
    );
    const product = productResult.rows[0];
    if (!product || Number(product.stock) < item.quantity) {
      throw new OrderNeedsReviewError("An already paid item is out of stock.");
    }
    if (Number(product.seller_id) !== item.sellerId) {
      throw new OrderNeedsReviewError("The seller changed after payment.");
    }
  }

  const orderResult = await client.query(
    "INSERT INTO orders (user_id, total_amount, status, delivery) VALUES ($1, $2, 'processing', $3::jsonb) RETURNING id, user_id, total_amount, status, created_at",
    [buyerId, (totalMinor / 100).toFixed(2), JSON.stringify(delivery)]
  );
  const order = orderResult.rows[0];
  if (!positiveId(order?.id)) {
    throw new Error("Database did not return a created order.");
  }

  for (const item of items) {
    await client.query(
      "INSERT INTO order_items (order_id, product_id, quantity, price) VALUES ($1, $2, $3, $4)",
      [order.id, item.id, item.quantity, (item.unitPriceMinor / 100).toFixed(2)]
    );
    await client.query(
      "UPDATE products SET stock = stock - $1 WHERE id = $2",
      [item.quantity, item.id]
    );
  }

  await client.query(
    "UPDATE payments SET order_id = $1, updated_at = NOW() WHERE id = $2 AND order_id IS NULL",
    [order.id, paymentId]
  );

  // Ledger records only. They do not send money to sellers.
  for (const [sellerId, grossMinor] of [...sellerTotals.entries()].sort((a, b) => a[0] - b[0])) {
    const commissionMinor = Math.round(grossMinor * 6 / 100);
    await client.query(
      "INSERT INTO seller_order_allocations (order_id, payment_id, seller_id, currency, gross_minor, commission_minor, seller_net_minor, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_review')",
      [order.id, paymentId, sellerId, orderCurrency, String(grossMinor),
        String(commissionMinor), String(grossMinor - commissionMinor)]
    );
  }

  await client.query(
    "INSERT INTO notifications (user_id, title, message, type, is_read) VALUES ($1, $2, $3, 'order', FALSE)",
    [buyerId, "Order placed successfully",
      "Your GoldMart order #" + order.id + " is being processed."]
  );

  for (const sellerId of [...sellerTotals.keys()].sort((a, b) => a - b)) {
    await client.query(
      "INSERT INTO notifications (user_id, title, message, type, is_read) VALUES ($1, 'New order received', $2, 'seller', FALSE)",
      [sellerId, "You have received GoldMart order #" + order.id + "."]
    );
  }

  // Only remove matching purchased cart quantities.
  for (const item of items) {
    await client.query(
      "DELETE FROM cart_items ci USING carts c WHERE ci.cart_id = c.id AND c.user_id = $1 AND ci.product_id = $2 AND ci.quantity = $3",
      [buyerId, item.id, item.quantity]
    );
  }

  return {
    order,
    alreadyExists: false,
    orderCurrency,
    orderTotal: totalMinor / 100,
  };
}

module.exports = { finalizePaidOrder, OrderNeedsReviewError };
