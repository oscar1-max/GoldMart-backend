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

  // =====================================================
  // GET LOGGED-IN BUYER'S ORDERS
  // =====================================================

router.get("/", protect, async (req, res) => {
  try {
    const ordersResult = await pool.query(
      `
      SELECT
        id,
        total_amount,
        status,
        created_at
      FROM orders
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      `,
      [req.user.id]
    );

    const orders = [];

    for (const order of ordersResult.rows) {
      const itemsResult = await pool.query(
        `
        SELECT
          oi.id,
          oi.product_id,
          oi.quantity,
          oi.price,
          p.name,
          p.image_url,
          p.seller_id,
          p.currency
        FROM order_items oi
        LEFT JOIN products p
          ON p.id = oi.product_id
        WHERE oi.order_id = $1
        ORDER BY oi.id ASC
        `,
        [order.id]
      );

      orders.push({
        ...order,
        items: itemsResult.rows,
      });
    }

    return res.json({
      success: true,
      orders,
    });
  } catch (error) {
    console.error(
      "Get buyer orders error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message: "Failed to fetch orders.",
    });
  }
});

// =====================================================
// GET SELLER'S CUSTOMER ORDERS
// =====================================================

router.get(
  "/seller/all",
  protect,
  async (req, res) => {
    try {
      const sellerId = Number(req.user.id);

      const ordersResult = await pool.query(
        `
        SELECT DISTINCT
          o.id,
          o.user_id,
          o.total_amount,
          o.status,
          o.created_at,
          u.name AS customer_name,
          u.email AS customer_email
        FROM orders o

        INNER JOIN order_items oi
          ON oi.order_id = o.id

        INNER JOIN products p
          ON p.id = oi.product_id

        INNER JOIN users u
          ON u.id = o.user_id

        WHERE p.seller_id = $1

        ORDER BY o.created_at DESC
        `,
        [sellerId]
      );

      const orders = [];

      for (const order of ordersResult.rows) {
        const itemsResult = await pool.query(
          `
          SELECT
            oi.id,
            oi.product_id,
            p.name AS product_name,
            oi.quantity,
            oi.price,
            p.image_url,
            p.currency,
            p.seller_id
          FROM order_items oi

          INNER JOIN products p
            ON p.id = oi.product_id

          WHERE oi.order_id = $1
            AND p.seller_id = $2

          ORDER BY oi.id ASC
          `,
          [order.id, sellerId]
        );

        orders.push({
          ...order,
          items: itemsResult.rows,
        });
      }

      return res.json({
        success: true,
        orders,
      });
    } catch (error) {
      console.error(
        "Get seller orders error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        message: "Failed to fetch seller orders.",
      });
    }
  }
);

// =====================================================
// UPDATE SELLER ORDER STATUS
// =====================================================

router.put(
  "/seller/:orderId/status",
  protect,
  async (req, res) => {
    const orderId = Number(req.params.orderId);
    const sellerId = Number(req.user.id);

    const status = String(
      req.body?.status || ""
    ).toLowerCase();

    const allowedStatuses = [
      "pending",
      "processing",
      "shipped",
      "delivered",
      "cancelled",
    ];

    if (
      !Number.isInteger(orderId) ||
      orderId <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid order ID.",
      });
    }

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order status.",
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Lock the order while verifying seller access.
      const orderResult = await client.query(
        `
        SELECT
          id,
          user_id,
          status
        FROM orders
        WHERE id = $1
        FOR UPDATE
        `,
        [orderId]
      );

      if (!orderResult.rows.length) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          message: "Order not found.",
        });
      }

      const ownershipResult = await client.query(
        `
        SELECT DISTINCT
          p.seller_id
        FROM order_items oi

        INNER JOIN products p
          ON p.id = oi.product_id

        WHERE oi.order_id = $1
        `,
        [orderId]
      );

      const sellerIds = ownershipResult.rows.map(
        (row) => Number(row.seller_id)
      );

      if (!sellerIds.includes(sellerId)) {
        await client.query("ROLLBACK");

        return res.status(403).json({
          success: false,
          message:
            "You are not authorized to manage this order.",
        });
      }

      // The current database uses one status per order.
      // Prevent one seller from changing the status
      // of an order involving multiple sellers.
      if (sellerIds.length !== 1) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message:
            "Multi-seller orders require separate seller fulfillment tracking.",
        });
      }

      const currentStatus = String(
        orderResult.rows[0].status || ""
      ).toLowerCase();

      if (currentStatus === "cancelled") {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message:
            "A cancelled order cannot be updated.",
        });
      }

      if (
        currentStatus === "delivered" &&
        status !== "delivered"
      ) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message:
            "A delivered order cannot be moved backwards.",
        });
      }

      const updatedResult = await client.query(
        `
        UPDATE orders
        SET status = $1
        WHERE id = $2

        RETURNING
          id,
          user_id,
          total_amount,
          status,
          created_at
        `,
        [status, orderId]
      );

      const updatedOrder = updatedResult.rows[0];

      // Notify buyer when status actually changes.
      if (currentStatus !== status) {
        await client.query(
          `
          INSERT INTO notifications (
            user_id,
            title,
            message,
            type,
            is_read
          )
          VALUES ($1, $2, $3, $4, FALSE)
          `,
          [
            updatedOrder.user_id,
            "Order status updated",
            `Your GoldMart order #${orderId} is now "${status}".`,
            "order",
          ]
        );
      }

      await client.query("COMMIT");

      return res.json({
        success: true,
        message:
          "Order status updated successfully.",
        order: updatedOrder,
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "Order rollback error:",
          rollbackError.message
        );
      }

      console.error(
        "Update seller order status error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to update order status.",
      });
    } finally {
      client.release();
    }
  }
);

// =====================================================
// GET ONE BUYER ORDER
// =====================================================

router.get(
  "/:orderId",
  protect,
  async (req, res) => {
    try {
      const orderId = Number(req.params.orderId);

      if (
        !Number.isInteger(orderId) ||
        orderId <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid order ID.",
        });
      }

      const orderResult = await pool.query(
        `
        SELECT
          id,
          user_id,
          total_amount,
          status,
          created_at
        FROM orders
        WHERE id = $1
          AND user_id = $2
        LIMIT 1
        `,
        [orderId, req.user.id]
      );

      if (!orderResult.rows.length) {
        return res.status(404).json({
          success: false,
          message: "Order not found.",
        });
      }

      const itemsResult = await pool.query(
        `
        SELECT
          oi.id,
          oi.product_id,
          oi.quantity,
          oi.price,
          p.name,
          p.image_url,
          p.seller_id,
          p.currency
        FROM order_items oi

        LEFT JOIN products p
          ON p.id = oi.product_id

        WHERE oi.order_id = $1

        ORDER BY oi.id ASC
        `,
        [orderId]
      );

      return res.json({
        success: true,
        order: orderResult.rows[0],
        items: itemsResult.rows,
      });
    } catch (error) {
      console.error(
        "Get order details error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to fetch order details.",
      });
    }
  }
);

// =====================================================
// EXPORT ROUTER
// =====================================================

module.exports = router;
