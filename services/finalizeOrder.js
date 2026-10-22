const pool = require("../db");
function validId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function finishTransaction(client, commit) {
  await client.query(commit ? "COMMIT" : "ROLLBACK");
}


const result = (status, body) => ({ status, body });
async function finalizeOrder(userId, reference) {
  reference = String(reference || "").trim();

  if (!reference) {
    return result(400, {
      success: false,
      message: "Payment reference is required.",
    });
  }

  const buyerId = validId(userId);

  if (!buyerId) {
    return result(401, {
      success: false,
      message: "Please sign in.",
    });
  }

  const client = await pool.connect();
  let inTransaction = false;

  try {
    await client.query("BEGIN");
    inTransaction = true;

    // Lock the payment to prevent duplicate orders.

    const paymentResult = await client.query(
      `
      SELECT
        id,
        user_id,
        order_id,
        reference,
        amount,
        currency,
        status,
        checkout_snapshot
      FROM payments
      WHERE reference = $1
        AND user_id = $2
      FOR UPDATE
      `,
      [reference, buyerId]
    );

    if (!paymentResult.rows.length) {
      await finishTransaction(client, false);
      inTransaction = false;

      return result(404, {
        success: false,
        message: "Payment was not found for this account.",
      });
    }

    const payment = paymentResult.rows[0];

    if (payment.order_id) {
      const existing = await client.query(
        `
        SELECT id, user_id, total_amount, status, created_at
        FROM orders
        WHERE id = $1
          AND user_id = $2
        `,
        [payment.order_id, buyerId]
      );

      await finishTransaction(client, true);
      inTransaction = false;

      if (!existing.rows.length) {
        return result(409, {
          success: false,
          message:
            "Order record needs support review. Do not pay again.",
        });
      }

      return result(200, {
        success: true,
        message: "Order already exists.",
        order: existing.rows[0],
      });
    }

    if (payment.status !== "success") {
      await finishTransaction(client, false);
      inTransaction = false;

      return result(409, {
        success: false,
        message:
          "Payment has not been verified. If Paystack charged you, retry confirmation; do not pay again.",
      });
    }

    const snapshot = payment.checkout_snapshot;

    if (
      !snapshot ||
      snapshot.schema_version !== 1 ||
      !Array.isArray(snapshot.items) ||
      snapshot.items.length === 0
    ) {
      await finishTransaction(client, false);
      inTransaction = false;

      return result(409, {
        success: false,
        message:
          "This earlier payment needs reconciliation. If charged, do not pay again; contact support with your reference.",
      });
    }

    const orderCurrency = String(
      snapshot.order_currency || ""
    ).toUpperCase();

    const totalMinor = Number(snapshot.order_total_minor);
    const expectedKobo = Number(snapshot.expected_kobo);
    const paidKobo = Math.round(Number(payment.amount) * 100);

    if (
      !["USD", "NGN"].includes(orderCurrency) ||
      !Number.isSafeInteger(totalMinor) ||
      totalMinor <= 0 ||
      !Number.isSafeInteger(expectedKobo) ||
      expectedKobo <= 0 ||
      !Number.isSafeInteger(paidKobo) ||
      paidKobo !== expectedKobo ||
      String(payment.currency).toUpperCase() !== "NGN"
    ) {
      await finishTransaction(client, false);
      inTransaction = false;

      return result(409, {
        success: false,
        message:
          "Payment values require support review. If charged, do not pay again.",
      });
    }

    // =================================================
    // VALIDATE ITEMS AND CALCULATE SELLER ALLOCATIONS
    // =================================================
    //
    // gross_minor is in the order currency:
    // USD cents or NGN kobo.
    //
    // These are records, not withdrawable balances.

    const items = [];
    const productIds = new Set();
    const sellerTotals = new Map();

    let computedMinor = 0;

    for (const entry of snapshot.items) {
      const id = validId(entry.product_id);
      const sellerId = validId(entry.seller_id);
      const quantity = Number(entry.quantity);
      const unitPriceMinor = Number(entry.unit_price_minor);

      if (
        !id ||
        !sellerId ||
        productIds.has(id) ||
        !Number.isSafeInteger(quantity) ||
        quantity <= 0 ||
        !Number.isSafeInteger(unitPriceMinor) ||
        unitPriceMinor <= 0
      ) {
        throw new Error("Invalid payment snapshot items.");
      }

      const lineMinor = quantity * unitPriceMinor;
      const nextTotal = computedMinor + lineMinor;

      const nextSellerTotal =
        (sellerTotals.get(sellerId) || 0) + lineMinor;

      if (
        !Number.isSafeInteger(lineMinor) ||
        lineMinor <= 0 ||
        !Number.isSafeInteger(nextTotal) ||
        !Number.isSafeInteger(nextSellerTotal)
      ) {
        throw new Error(
          "Payment snapshot total exceeds the supported limit."
        );
      }

      productIds.add(id);
      computedMinor = nextTotal;

      sellerTotals.set(sellerId, nextSellerTotal);

      items.push({
        id,
        sellerId,
        quantity,
        unitPriceMinor,
      });
    }

    if (computedMinor !== totalMinor) {
      throw new Error(
        "Payment snapshot totals are inconsistent."
      );
    }

    // =================================================
    // LOCK AND VALIDATE PRODUCT STOCK
    // =================================================

    for (const item of [...items].sort(
      (a, b) => a.id - b.id
    )) {
      const productResult = await client.query(
        `
        SELECT id, stock, seller_id
        FROM products
        WHERE id = $1
        FOR UPDATE
        `,
        [item.id]
      );

      const product = productResult.rows[0];

      if (!product || Number(product.stock) < item.quantity) {
        await finishTransaction(client, false);
        inTransaction = false;

        return result(409, {
          success: false,
          message:
            "A paid item is unavailable. Your payment requires assistance; do not pay again.",
        });
      }

      if (Number(product.seller_id) !== item.sellerId) {
        await finishTransaction(client, false);
        inTransaction = false;

        return result(409, {
          success: false,
          message:
            "A seller changed after payment. Contact support; do not pay again.",
        });
      }
    }

    const delivery =
      snapshot.delivery &&
      typeof snapshot.delivery === "object" &&
      !Array.isArray(snapshot.delivery)
        ? snapshot.delivery
        : {};

    // =================================================
    // CREATE ORDER
    // =================================================

    const orderResult = await client.query(
      `
      INSERT INTO orders (
        user_id,
        total_amount,
        status,
        currency,
        delivery
      )
      VALUES ($1, $2, 'processing', $4, $3::jsonb)
      RETURNING
        id,
        user_id,
        total_amount,
        status,
        created_at
      `,
      [
        buyerId,
        (totalMinor / 100).toFixed(2),
        JSON.stringify(delivery),
        orderCurrency,
      ]
    );

    const order = orderResult.rows[0];

    // =================================================
    // CREATE ORDER ITEMS AND REDUCE STOCK
    // =================================================

    for (const item of items) {
      await client.query(
        `
        INSERT INTO order_items (
          order_id,
          product_id,
          quantity,
          price
        )
        VALUES ($1, $2, $3, $4)
        `,
        [
          order.id,
          item.id,
          item.quantity,
          (item.unitPriceMinor / 100).toFixed(2),
        ]
      );

      await client.query(
        `
        UPDATE products
        SET stock = stock - $1
        WHERE id = $2
        `,
        [item.quantity, item.id]
      );
    }

    // =================================================
    // CONNECT PAYMENT TO ORDER
    // =================================================

    await client.query(
      `
      UPDATE payments
      SET
        order_id = $1,
        updated_at = NOW()
      WHERE id = $2
      `,
      [order.id, payment.id]
    );

    // =================================================
    // TASK 8 — RECORD SELLER ALLOCATIONS
    // =================================================
    //
    // One allocation per seller per order.
    //
    // No money is transferred.
    // No escrow funds are held by this code.
    // Withdrawals remain disabled.
    //
    // This happens in the SAME transaction as
    // order creation and stock reduction.

    for (const [sellerId, grossMinor] of [
      ...sellerTotals.entries(),
    ].sort((a, b) => a[0] - b[0])) {
      await client.query(
        `
        INSERT INTO seller_order_allocations (
          order_id,
          payment_id,
          seller_id,
          currency,
          gross_minor,
          status
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          'pending_review'
        )
        `,
        [
          order.id,
          payment.id,
          sellerId,
          orderCurrency,
          String(grossMinor),
        ]
      );
    }

    for (const sellerId of sellerTotals.keys()) {
      await client.query(`INSERT INTO order_fulfillments (order_id, seller_id, status)
        VALUES ($1, $2, 'processing')`, [order.id, sellerId]);
    }

    // =================================================
    // NOTIFY BUYER
    // =================================================

    await client.query(
      `
      INSERT INTO notifications (
        user_id,
        title,
        message,
        type,
        is_read
      )
      VALUES ($1, $2, $3, 'order', FALSE)
      `,
      [
        buyerId,
        "Order placed successfully",
        `Your GoldMart order #${order.id} is being processed.`,
      ]
    );

    // =================================================
    // NOTIFY EACH SELLER
    // =================================================

    for (const sellerId of [
      ...sellerTotals.keys(),
    ].sort((a, b) => a - b)) {
      await client.query(
        `
        INSERT INTO notifications (
          user_id,
          title,
          message,
          type,
          is_read
        )
        VALUES (
          $1,
          'New order received',
          $2,
          'seller',
          FALSE
        )
        `,
        [
          sellerId,
          `You have received GoldMart order #${order.id}.`,
        ]
      );
    }

    // =================================================
    // REMOVE PURCHASED CART ITEMS
    // =================================================

    for (const item of items) {
      await client.query(
        `
        DELETE FROM cart_items ci
        USING carts c
        WHERE ci.cart_id = c.id
          AND c.user_id = $1
          AND ci.product_id = $2
          AND ci.quantity = $3
        `,
        [
          buyerId,
          item.id,
          item.quantity,
        ]
      );
    }

    await finishTransaction(client, true);
    inTransaction = false;

    return result(201, {
      success: true,
      message:
        "Verified payment confirmed and order created successfully.",
      order,
      payment: {
        reference,
        status: "success",
        currency: "NGN",
        amount_ngn: Number(payment.amount),
      },
      order_currency: orderCurrency,
      order_total: totalMinor / 100,
    });
  } catch (error) {
    if (inTransaction) {
      try {
        await finishTransaction(client, false);
      } catch (rollbackError) {
        console.error(
          "Order rollback error:",
          rollbackError.message
        );
      }
    }

    console.error("Create order error:", error.message);

    return result(500, {
      success: false,
      message:
        "Unable to finalize this payment. If Paystack charged you, do not pay again; contact support with your reference.",
    });
  } finally {
    client.release();
  }
}
module.exports = { finalizeOrder };
