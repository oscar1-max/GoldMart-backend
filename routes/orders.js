
const express = require("express");
const pool = require("../db");
const { protect } = require("../middleware/auth");

const router = express.Router();

function validId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function finishTransaction(client, commit) {
  await client.query(commit ? "COMMIT" : "ROLLBACK");
}

// =====================================================
// CREATE ORDER FROM VERIFIED PAYMENT
// POST /api/orders
// =====================================================
const { finalizeOrder } = require('../services/finalizeOrder');
router.post("/", protect, async (req, res) => {
  const result = await finalizeOrder(req.user.id, req.body?.paymentReference);
  return res.status(result.status).json(result.body);
});

// =====================================================
// GET BUYER ORDERS
// GET /api/orders
// =====================================================

router.get("/", protect, async (req, res) => {
  try {
    const ordersResult = await pool.query(
      `
      SELECT
        id,
        total_amount,
        currency,
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
      const sellerId = validId(req.user.id);

      if (!sellerId) {
        return res.status(401).json({
          success: false,
          message: "Please sign in.",
        });
      }

      const ordersResult = await pool.query(
        `
        SELECT DISTINCT
          o.id,
          o.user_id,
          o.total_amount,
          o.currency,
          o.delivery,
          COALESCE(f.status, o.status) AS status,
          o.created_at,
          u.name AS customer_name,
          u.email AS customer_email
        FROM orders o
        LEFT JOIN order_fulfillments f ON f.order_id = o.id AND f.seller_id = $1
        JOIN order_items oi
          ON oi.order_id = o.id
        JOIN products p
          ON p.id = oi.product_id
        JOIN users u
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
          JOIN products p
            ON p.id = oi.product_id
          WHERE oi.order_id = $1
            AND p.seller_id = $2
          ORDER BY oi.id ASC
          `,
          [order.id, sellerId]
        );

        orders.push({
          ...order,
          total_amount: itemsResult.rows.reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0),
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
// SELLER ORDER STATUS
// PUT /api/orders/seller/:orderId/status
// =====================================================

router.put(
  "/seller/:orderId/status",
  protect,
  async (req, res) => {
    const orderId = validId(req.params.orderId);
    const sellerId = validId(req.user?.id);

    const status = String(
      req.body?.status || ""
    ).trim().toLowerCase();

    if (!orderId || !sellerId) {
      return res.status(400).json({
        success: false,
        message:
          "Valid order and account are required.",
      });
    }

    if (![
      "processing",
      "shipped",
      "delivered",
    ].includes(status)) {
      return res.status(400).json({
        success: false,
        message:
          "Sellers can only progress an order to Processing, Shipped, or Delivered. Cancellations require buyer protection and admin review.",
      });
    }

    const client = await pool.connect();
    let inTransaction = false;

    try {
      await client.query("BEGIN");
      inTransaction = true;

      const orderResult = await client.query(
        `
        SELECT id, user_id, status
        FROM orders
        WHERE id = $1
        FOR UPDATE
        `,
        [orderId]
      );

      if (!orderResult.rows.length) {
        await finishTransaction(client, false);
        inTransaction = false;

        return res.status(404).json({
          success: false,
          message: "Order not found.",
        });
      }

      // Confirm that this seller owns the order.

      const ownershipResult = await client.query(
        `
        SELECT DISTINCT p.seller_id
        FROM order_items oi
        JOIN products p
          ON p.id = oi.product_id
        WHERE oi.order_id = $1
        `,
        [orderId]
      );

      const sellerIds = ownershipResult.rows
        .map((row) => validId(row.seller_id))
        .filter(Boolean);

      if (!sellerIds.includes(sellerId)) {
        await finishTransaction(client, false);
        inTransaction = false;

        return res.status(403).json({
          success: false,
          message:
            "You are not authorized to manage this order.",
        });
      }

      for (const owner of sellerIds) {
        await client.query(`INSERT INTO order_fulfillments (order_id, seller_id, status)
          VALUES ($1, $2, $3) ON CONFLICT (order_id, seller_id) DO NOTHING`,
          [orderId, owner, orderResult.rows[0].status]);
      }
      const fulfillment = await client.query(`SELECT status FROM order_fulfillments
        WHERE order_id=$1 AND seller_id=$2 FOR UPDATE`, [orderId, sellerId]);

      // Active refund requests block fulfillment changes.

      const protectionResult = await client.query(
        `
        SELECT id, status
        FROM goldmart_refund_requests
        WHERE order_id = $1
          AND status <> 'rejected'
        LIMIT 1
        `,
        [orderId]
      );

      if (protectionResult.rows.length) {
        await finishTransaction(client, false);
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
        fulfillment.rows[0]?.status || ""
      ).trim().toLowerCase();

      if (currentStatus === "cancelled") {
        await finishTransaction(client, false);
        inTransaction = false;

        return res.status(409).json({
          success: false,
          message:
            "A cancelled order cannot be shipped or reopened by a seller.",
        });
      }

      const allowedNext = {
        pending: ["processing"],
        processing: ["shipped"],
        shipped: ["delivered"],
        delivered: [],
      };

      if (currentStatus === status) {
        await finishTransaction(client, true);
        inTransaction = false;

        return res.json({
          success: true,
          message: "Order already has this status.",
          order: {
            id: orderId,
            user_id: orderResult.rows[0].user_id,
            status: currentStatus,
          },
        });
      }

      if (
        !(allowedNext[currentStatus] || []).includes(status)
      ) {
        await finishTransaction(client, false);
        inTransaction = false;

        return res.status(409).json({
          success: false,
          message:
            `Cannot change an order from ${currentStatus} directly to ${status}. Follow Processing → Shipped → Delivered.`,
        });
      }

      await client.query(`UPDATE order_fulfillments SET status=$1, updated_at=NOW()
        WHERE order_id=$2 AND seller_id=$3`, [status, orderId, sellerId]);
      const all = await client.query('SELECT status FROM order_fulfillments WHERE order_id=$1', [orderId]);
      const statuses = all.rows.map(row => row.status);
      const aggregate = statuses.every(value => value === 'delivered') ? 'delivered'
        : statuses.every(value => ['shipped', 'delivered'].includes(value)) ? 'shipped' : 'processing';
      const updatedResult = await client.query(`UPDATE orders SET status=$1 WHERE id=$2
        RETURNING id, user_id, total_amount, status, created_at`, [aggregate, orderId]);
      const updatedOrder = updatedResult.rows[0];

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
          updatedOrder.user_id,
          "Order status updated",
          `Seller shipment for GoldMart order #${orderId} is now "${status}".`,
        ]
      );

      await finishTransaction(client, true);
      inTransaction = false;

      return res.json({
        success: true,
        message: "Order status updated successfully.",
        order: { ...updatedOrder, status, overall_status: updatedOrder.status },
      });
    } catch (error) {
      if (inTransaction) {
        try {
          await finishTransaction(client, false);
        } catch (rollbackError) {
          console.error(
            "Seller status rollback error:",
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
        message: "Failed to update order status.",
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
      const orderId = validId(req.params.orderId);

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
          currency,
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
        message: "Failed to fetch order details.",
      });
    }
  }
);

module.exports = router;
