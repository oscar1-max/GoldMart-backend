
const express = require("express");
const pool = require("../db");
const { protect } = require("../middleware/auth");

const router = express.Router();

// =====================================================
// HELPERS
// =====================================================

function validId(value) {
  const id = Number(value);

  return Number.isSafeInteger(id) && id > 0
    ? id
    : null;
}

function getUserId(req) {
  return validId(req.user?.id ?? req.user?.userId);
}

async function getOwnedOrder(client, orderId, userId) {
  const result = await client.query(
    `
    SELECT id, user_id, status, total_amount, created_at
    FROM orders
    WHERE id = $1 AND user_id = $2
    FOR UPDATE
    `,
    [orderId, userId]
  );

  return result.rows[0] || null;
}

// =====================================================
// REQUEST ORDER CANCELLATION OR REFUND
// POST /api/order-protection/:orderId/refund-request
// =====================================================

router.post(
  "/:orderId/refund-request",
  protect,
  async (req, res) => {
    const userId = getUserId(req);
    const orderId = validId(req.params.orderId);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Please sign in.",
      });
    }

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "Invalid order ID.",
      });
    }

    const reason =
      typeof req.body?.reason === "string"
        ? req.body.reason.trim()
        : "";

    if (reason.length < 10 || reason.length > 2000) {
      return res.status(400).json({
        success: false,
        message:
          "Please explain your request in 10 to 2000 characters.",
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const order = await getOwnedOrder(
        client,
        orderId,
        userId
      );

      if (!order) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          message: "Order not found.",
        });
      }

      const paidResult = await client.query(
        `
        SELECT id
        FROM payments
        WHERE order_id = $1
          AND user_id = $2
          AND status = 'success'
        LIMIT 1
        `,
        [orderId, userId]
      );

      if (!paidResult.rows.length) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message:
            "No verified payment was found for this order. Contact support if you were charged.",
        });
      }

      const existing = await client.query(
        `
        SELECT id, status, request_type
        FROM goldmart_refund_requests
        WHERE order_id = $1
        LIMIT 1
        `,
        [orderId]
      );

      if (existing.rows.length) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message:
            "A cancellation or refund request already exists for this order.",
          request: existing.rows[0],
        });
      }

      const orderStatus = String(
        order.status || ""
      ).toLowerCase();

      const requestType = [
        "pending",
        "processing",
        "cancelled",
      ].includes(orderStatus)
        ? "cancellation"
        : "return_refund";

      const result = await client.query(
        `
        INSERT INTO goldmart_refund_requests (
          order_id,
          buyer_id,
          request_type,
          reason,
          status
        )
        VALUES ($1, $2, $3, $4, 'requested')
        RETURNING
          id,
          order_id,
          buyer_id,
          request_type,
          reason,
          status,
          created_at
        `,
        [orderId, userId, requestType, reason]
      );

      // Tell the buyer that a request was received.
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
          userId,
          "Request received",
          `Your cancellation or refund request for order #${orderId} has been received.`,
        ]
      );

      await client.query("COMMIT");

      return res.status(201).json({
        success: true,
        message:
          "Your request has been submitted for review. No refund has been issued yet.",
        request: result.rows[0],
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error(
        "Create refund request error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Unable to submit your request. Please try again.",
      });
    } finally {
      client.release();
    }
  }
);

// =====================================================
// BUYER CONFIRMS SUCCESSFUL DELIVERY
// POST /api/order-protection/:orderId/confirm-delivery
// =====================================================

router.post(
  "/:orderId/confirm-delivery",
  protect,
  async (req, res) => {
    const userId = getUserId(req);
    const orderId = validId(req.params.orderId);

    if (!userId || !orderId) {
      return res.status(400).json({
        success: false,
        message: "Valid account and order required.",
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const order = await getOwnedOrder(
        client,
        orderId,
        userId
      );

      if (!order) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          message: "Order not found.",
        });
      }

      if (
        String(order.status).toLowerCase() !==
        "delivered"
      ) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message:
            "You can only confirm receipt after the order has been marked delivered.",
        });
      }

      const payment = await client.query(
        `
        SELECT id
        FROM payments
        WHERE order_id = $1
          AND user_id = $2
          AND status = 'success'
        LIMIT 1
        `,
        [orderId, userId]
      );

      if (!payment.rows.length) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message:
            "A verified payment is required before delivery confirmation.",
        });
      }

      const disputes = await client.query(
        `
        SELECT id
        FROM goldmart_refund_requests
        WHERE order_id = $1
          AND status <> 'rejected'
        LIMIT 1
        `,
        [orderId]
      );

      if (disputes.rows.length) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message:
            "This order has a cancellation or refund request that must be resolved first.",
        });
      }

      const result = await client.query(
        `
        INSERT INTO goldmart_delivery_confirmations (
          order_id,
          buyer_id
        )
        VALUES ($1, $2)
        ON CONFLICT (order_id) DO NOTHING
        RETURNING order_id, confirmed_at
        `,
        [orderId, userId]
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        message:
          "Delivery confirmation recorded. Seller payout remains subject to eligibility checks and the payment-provider arrangement.",
        already_confirmed:
          result.rows.length === 0,
        confirmation:
          result.rows[0] || null,
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error(
        "Delivery confirmation error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Unable to confirm delivery.",
      });
    } finally {
      client.release();
    }
  }
);

// =====================================================
// CHECK ORDER PROTECTION STATUS
// GET /api/order-protection/:orderId
// =====================================================

router.get("/:orderId", protect, async (req, res) => {
  try {
    const userId = getUserId(req);
    const orderId = validId(req.params.orderId);

    if (!userId || !orderId) {
      return res.status(400).json({
        success: false,
        message: "Invalid account or order.",
      });
    }

    const orderResult = await pool.query(
      `
      SELECT id, user_id, status, total_amount
      FROM orders
      WHERE id = $1 AND user_id = $2
      LIMIT 1
      `,
      [orderId, userId]
    );

    if (!orderResult.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Order not found.",
      });
    }

    const requestResult = await pool.query(
      `
      SELECT
        id,
        request_type,
        reason,
        status,
        review_note,
        provider_status,
        created_at,
        updated_at
      FROM goldmart_refund_requests
      WHERE order_id = $1
        AND buyer_id = $2
      LIMIT 1
      `,
      [orderId, userId]
    );

    const confirmationResult = await pool.query(
      `
      SELECT confirmed_at
      FROM goldmart_delivery_confirmations
      WHERE order_id = $1
        AND buyer_id = $2
      LIMIT 1
      `,
      [orderId, userId]
    );

    return res.json({
      success: true,
      order: orderResult.rows[0],
      refund_request:
        requestResult.rows[0] || null,
      delivery_confirmation:
        confirmationResult.rows[0] || null,
    });
  } catch (error) {
    console.error(
      "Order protection status error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to load order protection details.",
    });
  }
});

module.exports = router;
