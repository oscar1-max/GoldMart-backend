
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
  return validId(
    req.user?.id ?? req.user?.userId
  );
}

async function getOwnedOrder(client, orderId, userId) {
  const result = await client.query(
    `
    SELECT
      id,
      user_id,
      status,
      total_amount,
      created_at
    FROM orders
    WHERE id = $1
      AND user_id = $2
    FOR UPDATE
    `,
    [orderId, userId]
  );

  return result.rows[0] || null;
}

// =====================================================
// TASK 8 — REFUND AND SELLER PAYMENT PROTECTION
// =====================================================
//
// A refund request must block allocations that
// have not already reached a final settlement.
//
// This does not send refunds or payouts.
//
// Existing processing or paid transfers must
// remain unchanged and receive manual review.
//
// The order row is locked by the calling route
// before these operations are performed.
// =====================================================

async function blockSellerPaymentEligibility(
  client,
  orderId
) {
  // Block allocations that are not yet settled.
  //
  // Do not overwrite settled or voided records.
  // Settled records require separate reconciliation.

  const allocationsResult = await client.query(
    `
    UPDATE seller_order_allocations
    SET
      status = 'blocked',
      updated_at = NOW()
    WHERE order_id = $1
      AND status IN (
        'pending_review',
        'eligible'
      )
    RETURNING id
    `,
    [orderId]
  );

  // The old payout table is separate from
  // seller_order_allocations.
  //
  // Block only unprocessed eligible records.
  // Never overwrite processing or paid transfers.

  const payoutsResult = await client.query(
    `
    UPDATE goldmart_seller_payouts
    SET
      status = 'blocked',
      updated_at = NOW()
    WHERE order_id = $1
      AND status = 'eligible'
    RETURNING id
    `,
    [orderId]
  );

  // Detect transfer records that may require
  // investigation before any refund is issued.

  const startedPayoutsResult = await client.query(
    `
    SELECT EXISTS (
      SELECT 1
      FROM goldmart_seller_payouts
      WHERE order_id = $1
        AND status IN (
          'processing',
          'paid'
        )
    ) AS has_started_payout
    `,
    [orderId]
  );

  const settledAllocationsResult =
    await client.query(
      `
      SELECT EXISTS (
        SELECT 1
        FROM seller_order_allocations
        WHERE order_id = $1
          AND status = 'settled'
      ) AS has_settled_allocation
      `,
      [orderId]
    );

  return {
    blocked_allocations:
      allocationsResult.rowCount || 0,

    blocked_eligible_payouts:
      payoutsResult.rowCount || 0,

    manual_reconciliation_required:
      Boolean(
        startedPayoutsResult.rows[0]
          ?.has_started_payout
      ) ||
      Boolean(
        settledAllocationsResult.rows[0]
          ?.has_settled_allocation
      ),
  };
}

// =====================================================
// REQUEST ORDER CANCELLATION OR REFUND
//
// POST /api/order-protection/:orderId/refund-request
// =====================================================

router.post(
  "/:orderId/refund-request",
  protect,
  async (req, res) => {
    const userId = getUserId(req);
    const orderId = validId(
      req.params.orderId
    );

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

    if (
      reason.length < 10 ||
      reason.length > 2000
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Please explain your request in 10 to 2000 characters.",
      });
    }

    const client = await pool.connect();
    let inTransaction = false;

    try {
      await client.query("BEGIN");
      inTransaction = true;

      // Lock the buyer's order first.

      const order = await getOwnedOrder(
        client,
        orderId,
        userId
      );

      if (!order) {
        await client.query("ROLLBACK");
        inTransaction = false;

        return res.status(404).json({
          success: false,
          message: "Order not found.",
        });
      }

      // The order must have a verified payment.

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
        inTransaction = false;

        return res.status(409).json({
          success: false,
          message:
            "No verified payment was found for this order. Contact support if you were charged.",
        });
      }

      // Prevent duplicate refund requests.

      const existing = await client.query(
        `
        SELECT
          id,
          status,
          request_type
        FROM goldmart_refund_requests
        WHERE order_id = $1
        LIMIT 1
        `,
        [orderId]
      );

      if (existing.rows.length) {
        await client.query("ROLLBACK");
        inTransaction = false;

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

      // Record the request.

      const result = await client.query(
        `
        INSERT INTO goldmart_refund_requests (
          order_id,
          buyer_id,
          request_type,
          reason,
          status
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          'requested'
        )
        RETURNING
          id,
          order_id,
          buyer_id,
          request_type,
          reason,
          status,
          created_at
        `,
        [
          orderId,
          userId,
          requestType,
          reason,
        ]
      );

      // =================================================
      // TASK 8 — BLOCK SELLER ELIGIBILITY
      // =================================================

      const protection =
        await blockSellerPaymentEligibility(
          client,
          orderId
        );

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
          userId,
          "Request received",
          `Your cancellation or refund request for order #${orderId} has been received.`,
        ]
      );

      // Notify affected sellers.
      // This message makes no promise
      // about refunds or money movement.

      const sellersResult = await client.query(
        `
        SELECT DISTINCT
          seller_id
        FROM seller_order_allocations
        WHERE order_id = $1
        `,
        [orderId]
      );

      for (const row of sellersResult.rows) {
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
            'seller',
            FALSE
          )
          `,
          [
            row.seller_id,
            "Order under review",
            `A cancellation or refund request was submitted for order #${orderId}. Any unsettled allocation requires review.`,
          ]
        );
      }

      // Commit the request, accounting blocks,
      // and notifications together.

      await client.query("COMMIT");
      inTransaction = false;

      return res.status(201).json({
        success: true,
        message:
          "Your request has been submitted for review. No refund has been issued yet.",

        request: result.rows[0],

        payment_protection: {
          allocations_blocked:
            protection.blocked_allocations,

          eligible_payouts_blocked:
            protection.blocked_eligible_payouts,

          manual_reconciliation_required:
            protection.manual_reconciliation_required,
        },
      });
    } catch (error) {
      if (inTransaction) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error(
            "Refund request rollback error:",
            rollbackError.message
          );
        }
      }

      console.error(
        "Create refund request error:",
        error.message
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
//
// POST /api/order-protection/:orderId/confirm-delivery
// =====================================================

router.post(
  "/:orderId/confirm-delivery",
  protect,
  async (req, res) => {
    const userId = getUserId(req);
    const orderId = validId(
      req.params.orderId
    );

    if (!userId || !orderId) {
      return res.status(400).json({
        success: false,
        message:
          "Valid account and order required.",
      });
    }

    const client = await pool.connect();
    let inTransaction = false;

    try {
      await client.query("BEGIN");
      inTransaction = true;

      const order = await getOwnedOrder(
        client,
        orderId,
        userId
      );

      if (!order) {
        await client.query("ROLLBACK");
        inTransaction = false;

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
        inTransaction = false;

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
        inTransaction = false;

        return res.status(409).json({
          success: false,
          message:
            "A verified payment is required before delivery confirmation.",
        });
      }

      // Delivery confirmation cannot proceed
      // while a non-rejected dispute exists.

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
        inTransaction = false;

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
        ON CONFLICT (order_id)
          DO NOTHING
        RETURNING
          order_id,
          confirmed_at
        `,
        [orderId, userId]
      );

      await client.query("COMMIT");
      inTransaction = false;

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
      if (inTransaction) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error(
            "Delivery confirmation rollback error:",
            rollbackError.message
          );
        }
      }

      console.error(
        "Delivery confirmation error:",
        error.message
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
//
// GET /api/order-protection/:orderId
// =====================================================

router.get(
  "/:orderId",
  protect,
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const orderId = validId(
        req.params.orderId
      );

      if (!userId || !orderId) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid account or order.",
        });
      }

      const orderResult = await pool.query(
        `
        SELECT
          id,
          user_id,
          status,
          total_amount
        FROM orders
        WHERE id = $1
          AND user_id = $2
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

      const confirmationResult =
        await pool.query(
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
        error.message
      );

      return res.status(500).json({
        success: false,
        message:
          "Unable to load order protection details.",
      });
    }
  }
);

module.exports = router;
