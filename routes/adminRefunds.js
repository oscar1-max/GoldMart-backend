
const express = require("express");
const pool = require("../db");
const { protect } = require("../middleware/auth");

const router = express.Router();

// =====================================================
// HELPERS
// =====================================================

function validId(value) {
  const text = String(value ?? "");

  if (!/^[1-9]\d*$/.test(text)) {
    return null;
  }

  const id = Number(text);

  return Number.isSafeInteger(id) ? id : null;
}

// Only the user IDs explicitly configured
// in Render's ADMIN_USER_ID are administrators.

function isConfiguredAdmin(userId) {
  const configuredIds = String(
    process.env.ADMIN_USER_ID || ""
  )
    .split(",")
    .map((value) => validId(value.trim()))
    .filter(Boolean);

  return (
    configuredIds.length > 0 &&
    configuredIds.includes(Number(userId))
  );
}

function adminOnly(req, res, next) {
  if (
    !req.user ||
    !isConfiguredAdmin(req.user.id)
  ) {
    return res.status(403).json({
      success: false,
      message:
        "Only an authorized GoldMart administrator can access refund management.",
    });
  }

  next();
}

// =====================================================
// GET ALL REFUND REQUESTS
// GET /api/admin/refunds
// =====================================================

router.get(
  "/",
  protect,
  adminOnly,
  async (req, res) => {
    try {
      const allowedStatuses = [
        "requested",
        "under_review",
        "approved",
        "rejected",
        "refund_pending",
        "refunded",
        "refund_failed",
      ];

      const requestedStatus = String(
        req.query.status || ""
      ).trim().toLowerCase();

      if (
        requestedStatus &&
        !allowedStatuses.includes(requestedStatus)
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid refund status filter.",
        });
      }

      const rawPage = Number(
        req.query.page || 1
      );

      const page =
        Number.isSafeInteger(rawPage) &&
        rawPage > 0
          ? Math.min(rawPage, 100000)
          : 1;

      const limit = 20;
      const offset = (page - 1) * limit;

      const result = await pool.query(
        `
        SELECT
          r.id,
          r.order_id,
          r.buyer_id,
          r.request_type,
          r.reason,
          r.status,
          r.review_note,
          r.reviewed_by,
          r.provider_status,
          r.created_at,
          r.updated_at,

          o.status AS order_status,
          o.total_amount,

          u.name AS buyer_name,
          u.email AS buyer_email

        FROM goldmart_refund_requests r

        JOIN orders o
          ON o.id = r.order_id

        JOIN users u
          ON u.id = r.buyer_id

        WHERE (
          $1::text IS NULL
          OR r.status = $1
        )

        ORDER BY r.created_at DESC, r.id DESC

        LIMIT $2 OFFSET $3
        `,
        [
          requestedStatus || null,
          limit,
          offset,
        ]
      );

      return res.json({
        success: true,
        page,
        limit,
        requests: result.rows,
      });
    } catch (error) {
      console.error(
        "Admin refund list error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Unable to load refund requests.",
      });
    }
  }
);

// =====================================================
// REVIEW A REFUND REQUEST
// PATCH /api/admin/refunds/:requestId/review
//
// body:
// {
//   "decision": "approved" OR "rejected",
//   "note": "Reason for decision"
// }
//
// NO PAYSTACK REFUND OR PAYOUT IS SENT HERE.
// =====================================================

router.patch(
  "/:requestId/review",
  protect,
  adminOnly,
  async (req, res) => {
    const requestId = validId(
      req.params.requestId
    );

    const adminId = validId(
      req.user?.id
    );

    const decision = String(
      req.body?.decision || ""
    ).trim().toLowerCase();

    const note =
      typeof req.body?.note === "string"
        ? req.body.note.trim()
        : "";

    if (!requestId || !adminId) {
      return res.status(400).json({
        success: false,
        message:
          "Valid request and administrator required.",
      });
    }

    if (
      !["approved", "rejected"].includes(
        decision
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Decision must be approved or rejected.",
      });
    }

    if (
      note.length > 2000 ||
      (decision === "rejected" &&
        note.length < 10)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "A rejection requires an explanation of at least 10 characters. Maximum 2000 characters.",
      });
    }

    const client = await pool.connect();
    let inTransaction = false;

    try {
      await client.query("BEGIN");
      inTransaction = true;

      // Find the associated order.
      // Lock the order first so status updates,
      // delivery confirmation and review use
      // a consistent lock order.

      const lookupResult = await client.query(
        `
        SELECT order_id
        FROM goldmart_refund_requests
        WHERE id = $1
        `,
        [requestId]
      );

      if (!lookupResult.rows.length) {
        await client.query("ROLLBACK");
        inTransaction = false;

        return res.status(404).json({
          success: false,
          message:
            "Refund request not found.",
        });
      }

      const orderId =
        lookupResult.rows[0].order_id;

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
        await client.query("ROLLBACK");
        inTransaction = false;

        return res.status(404).json({
          success: false,
          message: "Order not found.",
        });
      }

      const requestResult = await client.query(
        `
        SELECT
          id,
          order_id,
          buyer_id,
          status,
          request_type
        FROM goldmart_refund_requests
        WHERE id = $1
        FOR UPDATE
        `,
        [requestId]
      );

      if (!requestResult.rows.length) {
        await client.query("ROLLBACK");
        inTransaction = false;

        return res.status(404).json({
          success: false,
          message:
            "Refund request not found.",
        });
      }

      const request =
        requestResult.rows[0];

      // Prevent self-review, including when
      // the administrator is the buyer.

      if (
        Number(request.buyer_id) === adminId
      ) {
        await client.query("ROLLBACK");
        inTransaction = false;

        return res.status(403).json({
          success: false,
          message:
            "You cannot review a refund request for your own purchase.",
        });
      }

      // Prevent review by an administrator
      // who also sells items in this order.

      const sellerConflict = await client.query(
        `
        SELECT EXISTS (
          SELECT 1
          FROM order_items oi
          JOIN products p
            ON p.id = oi.product_id
          WHERE oi.order_id = $1
            AND p.seller_id = $2
        ) AS conflict
        `,
        [orderId, adminId]
      );

      if (
        sellerConflict.rows[0]?.conflict
      ) {
        await client.query("ROLLBACK");
        inTransaction = false;

        return res.status(403).json({
          success: false,
          message:
            "You cannot review a refund involving your own products.",
        });
      }

      // Only new requests can be decided.
      // A completed decision cannot be
      // overwritten through this route.

      if (
        ![
          "requested",
          "under_review",
        ].includes(request.status)
      ) {
        await client.query("ROLLBACK");
        inTransaction = false;

        return res.status(409).json({
          success: false,
          message:
            "This request has already been decided or moved to payment processing.",
        });
      }

      // Approval here only means approved
      // for further processing.
      // It DOES NOT initiate a refund.

      const updatedResult = await client.query(
        `
        UPDATE goldmart_refund_requests
        SET
          status = $1,
          reviewed_by = $2,
          review_note = $3,
          updated_at = NOW()

        WHERE id = $4
          AND status IN (
            'requested',
            'under_review'
          )

        RETURNING
          id,
          order_id,
          buyer_id,
          request_type,
          status,
          review_note,
          reviewed_by,
          updated_at
        `,
        [
          decision,
          adminId,
          note || null,
          requestId,
        ]
      );

      if (!updatedResult.rows.length) {
        await client.query("ROLLBACK");
        inTransaction = false;

        return res.status(409).json({
          success: false,
          message:
            "Request status changed. Please refresh.",
        });
      }

      const updated =
        updatedResult.rows[0];

      const buyerMessage =
        decision === "approved"
          ? `Your refund request for order #${orderId} was approved for further processing. No refund has been completed yet.`
          : `Your refund request for order #${orderId} was not approved. Check Buyer Protection for the explanation.`;

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
          request.buyer_id,
          decision === "approved"
            ? "Refund request approved"
            : "Refund request reviewed",
          buyerMessage,
        ]
      );

      await client.query("COMMIT");
      inTransaction = false;

      return res.json({
        success: true,
        message:
          decision === "approved"
            ? "Request approved for further processing. No Paystack refund has been issued."
            : "Request rejected and buyer notified.",
        request: updated,
      });
    } catch (error) {
      if (inTransaction) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error(
            "Admin review rollback error:",
            rollbackError
          );
        }
      }

      console.error(
        "Admin refund review error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Unable to review refund request.",
      });
    } finally {
      client.release();
    }
  }
);

module.exports = router;
