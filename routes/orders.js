const express = require("express");
const pool = require("../db");
const { protect } = require("../middleware/auth");

const router = express.Router();

// =====================================================
// CREATE ORDER AFTER VERIFIED PAYMENT
// =====================================================

router.post("/", protect, async (req, res) => {
  const reference = String(
    req.body?.paymentReference || ""
  ).trim();

  if (!reference) {
    return res.status(400).json({
      success: false,
      message: "Payment reference is required.",
    });
  }

  const client = await pool.connect();
  let inTransaction = false;

  try {
    await client.query("BEGIN");
    inTransaction = true;

    // Get and lock the payment record.
    const paymentResult = await client.query(
      `
      SELECT
        id, user_id, order_id, reference,
        amount, currency, status,
        checkout_snapshot
      FROM payments
      WHERE reference = $1 AND user_id = $2
      FOR UPDATE
      `,
      [reference, req.user.id]
    );

    if (!paymentResult.rows.length) {
      await client.query("ROLLBACK");
      inTransaction = false;

      return res.status(404).json({
        success: false,
        message:
          "Payment was not found for this account.",
      });
    }

    const payment = paymentResult.rows[0];

    // Prevent duplicate orders.
    if (payment.order_id) {
      const existing = await client.query(
        `
        SELECT
          id, user_id, total_amount,
          status, created_at
        FROM orders
        WHERE id = $1 AND user_id = $2
        `,
        [payment.order_id, req.user.id]
      );

      await client.query("COMMIT");
      inTransaction = false;

      if (!existing.rows.length) {
        return res.status(409).json({
          success: false,
          message:
            "Order record needs support review. Do not pay again.",
        });
      }

      return res.json({
        success: true,
        message: "Order already exists.",
        order: existing.rows[0],
      });
    }

    // Verify payment status.
    if (payment.status !== "success") {
      await client.query("ROLLBACK");
      inTransaction = false;

      return res.status(409).json({
        success: false,
        message:
          "Payment has not been verified. If Paystack charged you, retry confirmation; do not pay again.",
      });
    }

    // Retrieve the original checkout snapshot.
    const snapshot = payment.checkout_snapshot;

    if (
      !snapshot ||
      snapshot.schema_version !== 1 ||
      !Array.isArray(snapshot.items) ||
      !snapshot.items.length
    ) {
      await client.query("ROLLBACK");
      inTransaction = false;

      return res.status(409).json({
        success: false,
        message:
          "This earlier payment needs reconciliation. If you were charged, do not pay again; contact support with the transaction reference.",
      });
    }

    const orderCurrency = String(
      snapshot.order_currency || ""
    ).toUpperCase();

    if (!["USD", "NGN"].includes(orderCurrency)) {
      throw new Error(
        "Unexpected checkout currency in payment snapshot."
      );
    }

    const totalMinor = Number(
      snapshot.order_total_minor
    );

    const snapshotKobo = Number(
      snapshot.expected_kobo
    );

    if (
      !Number.isSafeInteger(totalMinor) ||
      totalMinor <= 0 ||
      !Number.isSafeInteger(snapshotKobo) ||
      snapshotKobo <= 0 ||
      Math.round(Number(payment.amount) * 100) !==
        snapshotKobo ||
      String(payment.currency).toUpperCase() !==
        "NGN"
    ) {
      await client.query("ROLLBACK");
      inTransaction = false;

      return res.status(409).json({
        success: false,
        message:
          "Payment values require support review. If you were charged, do not pay again.",
      });
    }

    // Validate purchased items.
    let computedMinor = 0;

    const items = [];
    const ids = new Set();

    for (const entry of snapshot.items) {
      const id = Number(entry.product_id);
      const quantity = Number(entry.quantity);
      const unitPriceMinor = Number(
        entry.unit_price_minor
      );

      if (
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        ids.has(id) ||
        !Number.isSafeInteger(quantity) ||
        quantity <= 0 ||
        !Number.isSafeInteger(unitPriceMinor) ||
        unitPriceMinor <= 0
      ) {
        throw new Error(
          "Invalid payment snapshot items."
        );
      }

      ids.add(id);

      computedMinor +=
        quantity * unitPriceMinor;

      items.push({
        id,
        quantity,
        unitPriceMinor,
        sellerId: Number(entry.seller_id),
      });
    }

    if (
      !Number.isSafeInteger(computedMinor) ||
      computedMinor !== totalMinor
    ) {
      throw new Error(
        "Payment snapshot totals are inconsistent."
      );
    }

    // Lock product rows and check stock.
    for (
      const item of [...items].sort(
        (a, b) => a.id - b.id
      )
    ) {
      const result = await client.query(
        `
        SELECT id, name, stock, seller_id
        FROM products
        WHERE id = $1
        FOR UPDATE
        `,
        [item.id]
      );

      if (
        !result.rows.length ||
        Number(result.rows[0].stock) <
          item.quantity
      ) {
        await client.query("ROLLBACK");
        inTransaction = false;

        return res.status(409).json({
          success: false,
          message:
            "A paid item is unavailable. Your payment requires assistance; do not pay again.",
        });
      }

      if (
        Number(result.rows[0].seller_id) !==
        item.sellerId
      ) {
        await client.query("ROLLBACK");
        inTransaction = false;

        return res.status(409).json({
          success: false,
          message:
            "A seller changed after payment. Contact support to resolve this paid order; do not pay again.",
        });
      }
    }

    // Retrieve saved delivery details.
    const delivery =
      snapshot.delivery &&
      typeof snapshot.delivery === "object"
        ? snapshot.delivery
        : {};

    // Create order.
    const orderResult = await client.query(
      `
      INSERT INTO orders (
        user_id, total_amount,
        status, delivery
      )
      VALUES ($1, $2, 'processing', $3::jsonb)
      RETURNING
        id, user_id, total_amount,
        status, created_at
      `,
      [
        req.user.id,
        (totalMinor / 100).toFixed(2),
        JSON.stringify(delivery),
      ]
    );

    const order = orderResult.rows[0];

    // Save order items and reduce stock.
    for (const item of items) {
      await client.query(
        `
        INSERT INTO order_items (
          order_id, product_id,
          quantity, price
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

    // Link payment to order.
    await client.query(
      `
      UPDATE payments
      SET order_id = $1,
          updated_at = NOW()
      WHERE id = $2
      `,
      [order.id, payment.id]
    );

    // Notify buyer.
    await client.query(
      `
      INSERT INTO notifications (
        user_id, title, message,
        type, is_read
      )
      VALUES ($1, $2, $3, 'order', FALSE)
      `,
      [
        req.user.id,
        "Order placed successfully",
        `Your GoldMart order #${order.id} is being processed.`,
      ]
    );

    // Notify sellers.
    const sellers = [
      ...new Set(
        items
          .map((item) => item.sellerId)
          .filter(
            (id) =>
              Number.isInteger(id) &&
              id > 0
          )
      ),
    ];

    for (const sellerId of sellers) {
      await client.query(
        `
        INSERT INTO notifications (
          user_id, title, message,
          type, is_read
        )
        VALUES (
          $1, 'New order received',
          $2, 'seller', FALSE
        )
        `,
        [
          sellerId,
          `You have received GoldMart order #${order.id}.`,
        ]
      );
    }

    // Remove purchased items from the cart.
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
          req.user.id,
          item.id,
          item.quantity,
        ]
      );
    }

    await client.query("COMMIT");
    inTransaction = false;

    return res.status(201).json({
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
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "Order rollback error:",
          rollbackError.message
        );
      }
    }

    console.error(
      "Create order error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to finalize this payment. If Paystack charged you, do not pay again; contact support with your reference.",
    });
  } finally {
    client.release();
  }
});
