
const express = require("express");
const pool = require("../db");
const { protect } = require("../middleware/auth");

const router = express.Router();

function validId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// =====================================================
// CREATE AN ORDER FROM A VERIFIED PAYMENT SNAPSHOT
// POST /api/orders
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

    const paymentResult = await client.query(
      `
      SELECT id, user_id, order_id, reference,
             amount, currency, status, checkout_snapshot
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
        message: "Payment was not found for this account.",
      });
    }

    const payment = paymentResult.rows[0];

    // PREVENT DUPLICATE ORDERS

    if (payment.order_id) {
      const existing = await client.query(
        `
        SELECT id, user_id, total_amount, status, created_at
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

    // PAYMENT MUST BE VERIFIED

    if (payment.status !== "success") {
      await client.query("ROLLBACK");
      inTransaction = false;

      return res.status(409).json({
        success: false,
        message:
          "Payment has not been verified. If Paystack charged you, retry confirmation; do not pay again.",
      });
    }

    // LOAD ORIGINAL CHECKOUT DETAILS

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
          "This earlier payment needs reconciliation. If you were charged, do not pay again; contact support with your reference.",
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

    // VALIDATE ALL ORDER ITEMS

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

      computedMinor += quantity * unitPriceMinor;

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

    // CHECK STOCK BEFORE CREATING ORDER

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

    // SAVE DELIVERY INFORMATION

    const delivery =
      snapshot.delivery &&
      typeof snapshot.delivery === "object"
        ? snapshot.delivery
        : {};

    // CREATE THE ORDER

    const orderResult = await client.query(
      `
      INSERT INTO orders (
        user_id,
        total_amount,
        status,
        delivery
      )
      VALUES ($1, $2, 'processing', $3::jsonb)
      RETURNING
        id,
        user_id,
        total_amount,
        status,
        created_at
      `,
      [
        req.user.id,
        (totalMinor / 100).toFixed(2),
        JSON.stringify(delivery),
      ]
    );

    const order = orderResult.rows[0];

    // CREATE ORDER ITEMS AND REDUCE STOCK

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

    // CONNECT PAYMENT TO ORDER

    await client.query(
      `
      UPDATE payments
      SET order_id = $1,
          updated_at = NOW()
      WHERE id = $2
      `,
      [order.id, payment.id]
    );

    // NOTIFY BUYER

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
        req.user.id,
        "Order placed successfully",
        `Your GoldMart order #${order.id} is being processed.`,
      ]
    );

    // NOTIFY SELLERS

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

    // REMOVE PURCHASED CART ITEMS

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
// GET /api/orders
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
// GET /api/orders/seller/all
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
// PROTECT AGAINST CANCELLATION / REFUND REQUESTS
// PUT /api/orders/seller/:orderId/status
// =====================================================

router.put(
  "/seller/:orderId/status",
  protect,
  async (req, res) => {
    const orderId = validId(
      req.params.orderId
    );

    const sellerId = validId(
      req.user?.id
    );

    const status = String(
      req.body?.status || ""
    )
      .trim()
      .toLowerCase();

    if (!orderId || !sellerId) {
      return res.status(400).json({
        success: false,
        message:
          "Valid order and account are required.",
      });
    }

    // Sellers cannot approve refunds
    // by changing an order status.

    if (
      ![
        "processing",
        "shipped",
        "delivered",
      ].includes(status)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Sellers can only progress an order to Processing, Shipped, or Delivered. Cancellations must use buyer protection and admin review.",
      });
    }

    const client = await pool.connect();
    let inTransaction = false;

    try {
      await client.query("BEGIN");
      inTransaction = true;

      // Lock the order to prevent
      // simultaneous updates.

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
        inTransaction = false;

        return res.status(404).json({
          success: false,
          message: "Order not found.",
        });
      }

      // Confirm that this seller
      // owns the products in this order.

      const ownershipResult =
        await client.query(
          `
          SELECT DISTINCT p.seller_id
          FROM order_items oi
          JOIN products p
            ON p.id = oi.product_id
          WHERE oi.order_id = $1
          `,
          [orderId]
        );

      const sellerIds =
        ownershipResult.rows
          .map((row) =>
            Number(row.seller_id)
          )
          .filter(
            (id) =>
              Number.isSafeInteger(id) &&
              id > 0
          );

      if (!sellerIds.includes(sellerId)) {
        await client.query("ROLLBACK");
        inTransaction = false;

        return res.status(403).json({
          success: false,
          message:
            "You are not authorized to manage this order.",
        });
      }

      // One order can contain several
      // sellers, but each needs separate
      // fulfilment tracking.

      if (
        ownershipResult.rows.length !== 1 ||
        sellerIds.length !== 1
      ) {
        await client.query("ROLLBACK");
        inTransaction = false;

        return res.status(409).json({
          success: false,
          message:
            "Multi-seller orders need separate seller fulfillment tracking.",
        });
      }

      // =================================================
      // IMPORTANT: BLOCK ACTIVE REFUND REQUESTS
      // =================================================

      const protectionResult =
        await client.query(
          `
          SELECT
            id,
            status
          FROM goldmart_refund_requests
          WHERE order_id = $1
            AND status <> 'rejected'
          LIMIT 1
          `,
          [orderId]
        );

      if (protectionResult.rows.length) {
        await client.query("ROLLBACK");
        inTransaction = false;

        return res.status(409).json({
          success: false,
          message:
            "This order has an active cancellation or refund request. Do not ship or change its status until GoldMart support resolves it.",
          refund_request_status:
            protectionResult.rows[0].status,
        });
      }

      const currentStatus = String(
        orderResult.rows[0].status || ""
      )
        .trim()
        .toLowerCase();

      // Cannot reopen a cancelled order.

      if (currentStatus === "cancelled") {
        await client.query("ROLLBACK");
        inTransaction = false;

        return res.status(409).json({
          success: false,
          message:
            "A cancelled order cannot be shipped or reopened by a seller.",
        });
      }

      // Prevent skipping status steps.

      const allowedNext = {
        pending: ["processing"],
        processing: ["shipped"],
        shipped: ["delivered"],
        delivered: [],
      };

      // Avoid duplicate notifications
      // when status is unchanged.

      if (currentStatus === status) {
        await client.query("COMMIT");
        inTransaction = false;

        return res.json({
          success: true,
          message:
            "Order already has this status.",
          order: {
            id: orderId,
            user_id:
              orderResult.rows[0].user_id,
            status: currentStatus,
          },
        });
      }

      if (
        !(
          allowedNext[currentStatus] || []
        ).includes(status)
      ) {
        await client.query("ROLLBACK");
        inTransaction = false;

        return res.status(409).json({
          success: false,
          message:
            `Cannot change an order from ${currentStatus} directly to ${status}. Follow Processing → Shipped → Delivered.`,
        });
      }

      // =================================================
      // UPDATE THE ORDER
      // =================================================

      const updatedResult =
        await client.query(
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

      const updatedOrder =
        updatedResult.rows[0];

      // Notify the buyer.

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
          $2,
          $3,
          'order',
          FALSE
        )
        `,
        [
          updatedOrder.user_id,
          "Order status updated",
          `Your GoldMart order #${orderId} is now "${status}".`,
        ]
      );

      await client.query("COMMIT");
      inTransaction = false;

      return res.json({
        success: true,
        message:
          "Order status updated successfully.",
        order: updatedOrder,
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
// GET /api/orders/:orderId
// =====================================================

router.get(
  "/:orderId",
  protect,
  async (req, res) => {
    try {
      const orderId = validId(
        req.params.orderId
      );

      if (!orderId) {
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
