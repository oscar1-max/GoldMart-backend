
const express = require("express");
const pool = require("../db");
const { protect } = require("../middleware/auth");
const { finalizePaidOrder, OrderNeedsReviewError } = require("../services/finalizePaidOrder");
const { normalizeTracking } = require("../utils/shippingValidation");

const router = express.Router();

function validId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function finishTransaction(client, commit) {
  await client.query(commit ? "COMMIT" : "ROLLBACK");
}

// =====================================================
// CREATE OR RETRIEVE ORDER FROM VERIFIED PAYMENT
// POST /api/orders
// =====================================================
router.post("/", protect, async (req, res) => {
  const reference = String(req.body?.paymentReference || "").trim();
  if (!/^GM-[A-Za-z0-9-]{1,240}$/.test(reference)) {
    return res.status(400).json({ success: false, message: "Valid payment reference is required." });
  }

  const buyerId = validId(req.user?.id);
  if (!buyerId) {
    return res.status(401).json({ success: false, message: "Please sign in." });
  }

  let client;
  let inTransaction = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    inTransaction = true;

    const result = await client.query(
      "SELECT id, user_id, order_id, reference, amount, currency, status, checkout_snapshot FROM payments WHERE reference = $1 AND user_id = $2 FOR UPDATE",
      [reference, buyerId]
    );
    if (!result.rows.length) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return res.status(404).json({ success: false, message: "Payment was not found for your account." });
    }

    const payment = result.rows[0];
    if (payment.status !== "success") {
      await client.query("ROLLBACK");
      inTransaction = false;
      return res.status(409).json({
        success: false,
        message: "Payment is not confirmed. If you were charged, do not pay again."
      });
    }

    const finalized = await finalizePaidOrder(client, payment);
    await client.query("COMMIT");
    inTransaction = false;

    return res.status(finalized.alreadyExists ? 200 : 201).json({
      success: true,
      message: finalized.alreadyExists ? "Order already exists." : "Paid order created successfully.",
      order: finalized.order,
      payment: { reference, status: "success", currency: "NGN", amount_ngn: Number(payment.amount) },
      order_currency: finalized.orderCurrency,
      order_total: finalized.orderTotal
    });
  } catch (error) {
    if (inTransaction && client) await client.query("ROLLBACK").catch(() => {});
    console.error("Order finalization error:", error.message);
    return res.status(error instanceof OrderNeedsReviewError ? 409 : 500).json({
      success: false,
      message: "Unable to finalize this paid order. If charged, do not pay again; contact support with your reference."
    });
  } finally {
    if (client) client.release();
  }
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
          o.status,
          o.created_at,
          u.name AS customer_name,
          u.email AS customer_email
        FROM orders o
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
          items: itemsResult.rows,
        });
      }

      const shipmentRows = await pool.query(
        `SELECT s.order_id,s.carrier,s.tracking_number,s.status,s.updated_at
         FROM goldmart_shipments s
         JOIN orders o ON o.id=s.order_id
         WHERE s.seller_id=$1 AND o.id IN (
           SELECT oi.order_id FROM order_items oi
           JOIN products p ON p.id=oi.product_id WHERE p.seller_id=$1
         )`,
        [sellerId]
      );
      for (const order of orders) {
        order.shipment = shipmentRows.rows.find(row => Number(row.order_id) === Number(order.id)) || null;
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

      // Multi-seller fulfillment requires separate tracking.

      if (
        ownershipResult.rows.length !== 1 ||
        sellerIds.length !== 1
      ) {
        await finishTransaction(client, false);
        inTransaction = false;

        return res.status(409).json({
          success: false,
          message:
            "Multi-seller orders need separate seller fulfillment tracking.",
        });
      }

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
        orderResult.rows[0].status || ""
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
          `Your GoldMart order #${orderId} is now "${status}".`,
        ]
      );

      await finishTransaction(client, true);
      inTransaction = false;

      return res.json({
        success: true,
        message: "Order status updated successfully.",
        order: updatedOrder,
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
// SELLER-REPORTED SHIPMENT TRACKING (NOT LIVE CARRIER DATA)
// PUT /api/orders/seller/:orderId/shipment
// =====================================================
router.put("/seller/:orderId/shipment", protect, async (req, res) => {
  const orderId = validId(req.params.orderId);
  const sellerId = validId(req.user?.id);
  const checked = normalizeTracking(req.body);
  if (!orderId || !sellerId || !checked.ok) {
    return res.status(400).json({
      success: false,
      message: checked.message || "Valid order and seller are required.",
    });
  }
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    const orderResult = await client.query(
      "SELECT id, user_id, status FROM orders WHERE id=$1 FOR UPDATE",
      [orderId]
    );
    if (!orderResult.rows.length) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return res.status(404).json({ success: false, message: "Order not found." });
    }
    const ownership = await client.query(
      "SELECT DISTINCT p.seller_id FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=$1",
      [orderId]
    );
    const sellers = ownership.rows.map(row => validId(row.seller_id));
    if (sellers.length !== 1 || sellers[0] !== sellerId) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return res.status(403).json({
        success: false,
        message: "Shipment tracking is currently limited to single-seller orders owned by you.",
      });
    }
    if (!["shipped", "delivered"].includes(String(orderResult.rows[0].status).toLowerCase())) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return res.status(409).json({
        success: false, message: "Mark the order as shipped before adding tracking details.",
      });
    }
    const refunds = await client.query(
      "SELECT id FROM goldmart_refund_requests WHERE order_id=$1 AND status <> 'rejected' LIMIT 1",
      [orderId]
    );
    if (refunds.rows.length) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return res.status(409).json({
        success: false, message: "Shipment updates are paused while a refund or cancellation is under review.",
      });
    }
    const { carrier, trackingNumber, status } = checked.tracking;
    const saved = await client.query(
      `INSERT INTO goldmart_shipments (order_id,seller_id,carrier,tracking_number,status)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (order_id,seller_id) DO UPDATE SET
         carrier=EXCLUDED.carrier,
         tracking_number=EXCLUDED.tracking_number,
         status=EXCLUDED.status,
         updated_at=NOW()
       RETURNING id,order_id,seller_id,carrier,tracking_number,status,updated_at`,
      [orderId, sellerId, carrier, trackingNumber, status]
    );
    await client.query(
      "INSERT INTO notifications (user_id,title,message,type,is_read) VALUES ($1,$2,$3,'order',FALSE)",
      [orderResult.rows[0].user_id, "Shipment tracking added",
        "The seller provided shipping information for order #" + orderId + ". View your order for the reported carrier and tracking number."]
    );
    await client.query("COMMIT");
    inTransaction = false;
    return res.json({
      success: true,
      message: "Seller-reported tracking saved. This is not live carrier verification.",
      shipment: saved.rows[0],
    });
  } catch (error) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => {});
    console.error("Save shipment error:", error.message);
    return res.status(500).json({ success: false, message: "Unable to save shipment details." });
  } finally {
    client.release();
  }
});

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

      const shipmentsResult = await pool.query(
        "SELECT seller_id, carrier, tracking_number, status, updated_at FROM goldmart_shipments WHERE order_id=$1 ORDER BY seller_id",
        [orderId]
      );
      return res.json({
        success: true,
        order: orderResult.rows[0],
        items: itemsResult.rows,
        shipments: shipmentsResult.rows,
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
