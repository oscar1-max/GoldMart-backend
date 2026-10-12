
const express = require("express");
const pool = require("../db");
const { protect } = require("../middleware/auth");

const router = express.Router();

// ================================================
// HELPERS
// ================================================

function validId(input) {
  const value = String(input ?? "").trim();

  if (!/^[1-9]\d*$/.test(value)) {
    return null;
  }

  const id = Number(value);

  return Number.isSafeInteger(id) ? id : null;
}

function isAdmin(userId) {
  return String(process.env.ADMIN_USER_ID || "")
    .split(",")
    .map((value) => validId(value.trim()))
    .includes(Number(userId));
}

function adminOnly(req, res, next) {
  if (!req.user || !isAdmin(req.user.id)) {
    return res.status(403).json({
      success: false,
      message:
        "Authorized GoldMart administrator required.",
    });
  }

  next();
}

function koboFromNaira(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(
    String(value)
  );

  if (!match) return null;

  const kobo =
    Number(match[1]) * 100 +
    Number((match[2] || "").padEnd(2, "0"));

  return Number.isSafeInteger(kobo) &&
    kobo > 0
    ? kobo
    : null;
}

function normalizedStatus(status) {
  const value = String(status || "")
    .toLowerCase();

  if (
    [
      "pending",
      "processing",
      "processed",
      "failed",
    ].includes(value)
  ) {
    return value;
  }

  // Includes Paystack's needs-attention status.
  return "needs_review";
}

function buyerStatus(status) {
  if (status === "processed") {
    return "refunded";
  }

  if (status === "failed") {
    return "refund_failed";
  }

  return "refund_pending";
}

// Live Paystack refunds are deliberately disabled.
// Explicit test mode requires BOTH conditions.

function testRefundsEnabled() {
  const enabled =
    process.env.ENABLE_PAYSTACK_REFUNDS_TEST ===
    "true";

  const testKey = String(
    process.env.PAYSTACK_SECRET_KEY || ""
  ).startsWith("sk_test_");

  return enabled && testKey;
}

// ================================================
// PAYSTACK REQUEST HELPER
// ================================================

async function paystack(path, options = {}) {
  const key = process.env.PAYSTACK_SECRET_KEY;

  if (!key) {
    throw new Error(
      "Paystack is not configured."
    );
  }

  const response = await fetch(
    `https://api.paystack.co${path}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        ...(options.body
          ? {
              "Content-Type":
                "application/json",
            }
          : {}),
      },
      signal: AbortSignal.timeout(20000),
    }
  );

  const body = await response.json();

  if (
    !response.ok ||
    body.status !== true ||
    !body.data
  ) {
    throw new Error(
      "Paystack could not confirm the refund request."
    );
  }

  return body.data;
}

function validateProviderRefund(
  refund,
  expectedId,
  amountKobo
) {
  if (
    String(refund.id) !== String(expectedId) ||
    String(refund.currency || "")
      .toUpperCase() !== "NGN" ||
    Number(refund.amount) !== amountKobo
  ) {
    throw new Error(
      "Paystack refund details differ from GoldMart records."
    );
  }

  return normalizedStatus(refund.status);
}

// All endpoints require an authenticated admin.

router.use(protect, adminOnly);

// ================================================
// GET REFUND PROCESSING STATUS
//
// GET /api/admin/refund-processing/:requestId/status
// ================================================

router.get(
  "/:requestId/status",
  async (req, res) => {
    const requestId = validId(
      req.params.requestId
    );

    if (!requestId) {
      return res.status(400).json({
        success: false,
        message: "Invalid refund request ID.",
      });
    }

    try {
      const result = await pool.query(
        `
        SELECT
          a.id,
          a.request_id,
          a.amount_kobo,
          a.currency,
          a.status,
          a.provider_status,
          a.paystack_refund_id,
          r.status AS request_status
        FROM goldmart_refund_attempts a
        JOIN goldmart_refund_requests r
          ON r.id = a.request_id
        WHERE a.request_id = $1
        `,
        [requestId]
      );

      if (!result.rows.length) {
        return res.json({
          success: true,
          message:
            "No refund processing attempt exists for this request.",
          attempt: null,
        });
      }

      const attempt = result.rows[0];

      if (!attempt.paystack_refund_id) {
        return res.json({
          success: true,
          message:
            "No provider refund ID recorded. Manual review may be required.",
          attempt,
        });
      }

      // This version reconciles TEST refunds only.

      const testKey = String(
        process.env.PAYSTACK_SECRET_KEY || ""
      ).startsWith("sk_test_");

      if (!testKey) {
        return res.json({
          success: true,
          message:
            "Only test-mode provider reconciliation is enabled in this version.",
          attempt,
        });
      }

      let refund;

      try {
        refund = await paystack(
          `/refund/${encodeURIComponent(
            attempt.paystack_refund_id
          )}`
        );
      } catch (error) {
        return res.status(502).json({
          success: false,
          message:
            "Could not retrieve Paystack status. No new refund was sent.",
          attempt,
        });
      }

      let providerStatus;

      try {
        providerStatus = validateProviderRefund(
          refund,
          attempt.paystack_refund_id,
          Number(attempt.amount_kobo)
        );
      } catch (error) {
        return res.status(409).json({
          success: false,
          message:
            "Paystack refund details need manual review.",
        });
      }

      const client = await pool.connect();

      let finalStatus;

      try {
        await client.query("BEGIN");

        const locked = await client.query(
          `
          SELECT status
          FROM goldmart_refund_attempts
          WHERE request_id = $1
          FOR UPDATE
          `,
          [requestId]
        );

        const current =
          locked.rows[0]?.status;

        // Do not move a final state backward.

        finalStatus = [
          "processed",
          "failed",
        ].includes(current)
          ? current
          : providerStatus;

        await client.query(
          `
          UPDATE goldmart_refund_attempts
          SET
            status = $1,
            provider_status = $2,
            updated_at = NOW()
          WHERE request_id = $3
          `,
          [
            finalStatus,
            String(refund.status || "unknown"),
            requestId,
          ]
        );

        await client.query(
          `
          UPDATE goldmart_refund_requests
          SET
            status = $1,
            provider_status = $2,
            updated_at = NOW()
          WHERE id = $3
            AND status IN (
              'approved',
              'refund_pending',
              'refund_failed'
            )
          `,
          [
            buyerStatus(finalStatus),
            String(refund.status || "unknown"),
            requestId,
          ]
        );

        await client.query("COMMIT");
      } catch (error) {
        await client
          .query("ROLLBACK")
          .catch(() => {});

        throw error;
      } finally {
        client.release();
      }

      return res.json({
        success: true,
        message:
          finalStatus === "processed"
            ? "Paystack reports the refund processed. Bank arrival may take additional time."
            : "Refund status checked with Paystack.",
        status: finalStatus,
        provider_status: refund.status,
        refund_id: attempt.paystack_refund_id,
      });
    } catch (error) {
      console.error(
        "Refund status lookup error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        message:
          "Unable to check refund status.",
      });
    }
  }
);

// ================================================
// START A TEST REFUND
//
// POST /api/admin/refund-processing/:requestId/start
//
// Live-money refunds are NOT enabled.
// ================================================

router.post(
  "/:requestId/start",
  async (req, res) => {
    const requestId = validId(
      req.params.requestId
    );

    const adminId = validId(
      req.user.id
    );

    if (!requestId || !adminId) {
      return res.status(400).json({
        success: false,
        message: "Invalid request.",
      });
    }

    if (!testRefundsEnabled()) {
      return res.status(403).json({
        success: false,
        message:
          "Refund initiation is disabled. Test mode must be explicitly enabled by the operator; real-money refunds remain disabled.",
      });
    }

    const client = await pool.connect();

    let payment;
    let amountKobo;

    try {
      // ============================================
      // FIND THE VERIFIED ORIGINAL PAYMENT
      // ============================================

      const lookup = await client.query(
        `
        SELECT
          r.id,
          r.order_id,
          r.buyer_id,
          r.status,
          o.status AS order_status,
          p.id AS payment_id,
          p.reference,
          p.amount,
          p.currency,
          p.status AS payment_status,
          p.checkout_snapshot
        FROM goldmart_refund_requests r
        JOIN orders o
          ON o.id = r.order_id
        JOIN payments p
          ON p.order_id = o.id
         AND p.user_id = r.buyer_id
        WHERE r.id = $1
          AND p.status = 'success'
        `,
        [requestId]
      );

      if (lookup.rows.length !== 1) {
        return res.status(409).json({
          success: false,
          message:
            "Exactly one verified payment must be linked to this refund request.",
        });
      }

      payment = lookup.rows[0];

      if (payment.status !== "approved") {
        return res.status(409).json({
          success: false,
          message:
            "An administrator must approve this request before refund processing.",
        });
      }

      // No self-refunds.

      if (
        Number(payment.buyer_id) === adminId
      ) {
        return res.status(403).json({
          success: false,
          message:
            "Cannot process a refund for your own purchase.",
        });
      }

      amountKobo = koboFromNaira(
        payment.amount
      );

      if (
        String(payment.currency)
          .toUpperCase() !== "NGN" ||
        !amountKobo ||
        Number(
          payment.checkout_snapshot
            ?.expected_kobo
        ) !== amountKobo
      ) {
        return res.status(409).json({
          success: false,
          message:
            "Stored payment amount or currency needs manual review.",
        });
      }

      // ============================================
      // VERIFY THE PAYMENT DIRECTLY WITH PAYSTACK
      // ============================================

      const original = await paystack(
        `/transaction/verify/${encodeURIComponent(
          payment.reference
        )}`
      );

      if (
        String(original.reference) !==
          String(payment.reference) ||
        String(original.currency)
          .toUpperCase() !== "NGN" ||
        Number(original.amount) !==
          amountKobo ||
        original.status !== "success" ||
        original.domain !== "test"
      ) {
        return res.status(409).json({
          success: false,
          message:
            "Paystack original transaction is not eligible for test refund processing.",
        });
      }

      // ============================================
      // RESERVE THIS REFUND ATTEMPT EXACTLY ONCE
      // ============================================

      await client.query("BEGIN");

      const lockedOrder =
        await client.query(
          `
          SELECT id, user_id
          FROM orders
          WHERE id = $1
          FOR UPDATE
          `,
          [payment.order_id]
        );

      if (!lockedOrder.rows.length) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          message: "Order not found.",
        });
      }

      const lockedRequest =
        await client.query(
          `
          SELECT id, status, buyer_id
          FROM goldmart_refund_requests
          WHERE id = $1
          FOR UPDATE
          `,
          [requestId]
        );

      if (
        lockedRequest.rows[0]?.status !==
        "approved"
      ) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message:
            "Request is no longer approved for initiation.",
        });
      }

      // Administrator cannot process refunds
      // involving their own seller products.

      const conflict = await client.query(
        `
        SELECT EXISTS (
          SELECT 1
          FROM order_items oi
          JOIN products p
            ON p.id = oi.product_id
          WHERE oi.order_id = $1
            AND p.seller_id = $2
        ) AS seller_is_admin
        `,
        [payment.order_id, adminId]
      );

      if (
        conflict.rows[0]?.seller_is_admin
      ) {
        await client.query("ROLLBACK");

        return res.status(403).json({
          success: false,
          message:
            "Cannot process refunds for your own products.",
        });
      }

      // Prevent refund if a seller payout
      // has already started or completed.

      const payouts = await client.query(
        `
        SELECT id
        FROM goldmart_seller_payouts
        WHERE order_id = $1
          AND status IN ('processing', 'paid')
        LIMIT 1
        FOR UPDATE
        `,
        [payment.order_id]
      );

      if (payouts.rows.length) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message:
            "Seller payout has already started. Manual reconciliation required.",
        });
      }

      const reserved = await client.query(
        `
        INSERT INTO goldmart_refund_attempts (
          request_id,
          payment_id,
          payment_reference,
          amount_kobo,
          currency,
          status,
          started_by
        )
        VALUES (
          $1, $2, $3, $4,
          'NGN', 'reserved', $5
        )
        ON CONFLICT (request_id)
          DO NOTHING
        RETURNING id
        `,
        [
          requestId,
          payment.payment_id,
          payment.reference,
          amountKobo,
          adminId,
        ]
      );

      if (!reserved.rows.length) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message:
            "Refund processing has already been reserved or attempted. Check its status; do not submit again.",
        });
      }

      await client.query(
        `
        UPDATE goldmart_refund_requests
        SET
          status = 'refund_pending',
          updated_at = NOW()
        WHERE id = $1
        `,
        [requestId]
      );

      await client.query(
        `
        UPDATE goldmart_seller_payouts
        SET
          status = 'blocked',
          updated_at = NOW()
        WHERE order_id = $1
          AND status = 'eligible'
        `,
        [payment.order_id]
      );

      await client.query("COMMIT");
    } catch (error) {
      await client
        .query("ROLLBACK")
        .catch(() => {});

      console.error(
        "Refund preparation error:",
        error.message
      );

      return res.status(502).json({
        success: false,
        message:
          "Refund eligibility or original payment verification failed. No refund was initiated.",
      });
    } finally {
      client.release();
    }

    // ================================================
    // PAYSTACK TEST REFUND
    //
    // An API timeout is NOT proof of failure.
    // Never automatically send the refund twice.
    // ================================================

    try {
      const refund = await paystack(
        "/refund",
        {
          method: "POST",
          body: JSON.stringify({
            transaction:
              payment.reference,
            amount: amountKobo,
            currency: "NGN",
            merchant_note:
              `GoldMart approved request #${requestId}`,
          }),
        }
      );

      const refundId = validId(
        refund.id
      );

      if (!refundId) {
        throw new Error(
          "Paystack did not return a valid refund ID."
        );
      }

      const status = validateProviderRefund(
        refund,
        refundId,
        amountKobo
      );

      const updateClient =
        await pool.connect();

      try {
        await updateClient.query("BEGIN");

        await updateClient.query(
          `
          UPDATE goldmart_refund_attempts
          SET
            status = $1,
            provider_status = $2,
            paystack_refund_id = $3,
            updated_at = NOW()
          WHERE request_id = $4
          `,
          [
            status,
            String(
              refund.status || "unknown"
            ),
            String(refundId),
            requestId,
          ]
        );

        await updateClient.query(
          `
          UPDATE goldmart_refund_requests
          SET
            status = $1,
            provider_status = $2,
            paystack_refund_id = $3,
            updated_at = NOW()
          WHERE id = $4
          `,
          [
            buyerStatus(status),
            String(
              refund.status || "unknown"
            ),
            String(refundId),
            requestId,
          ]
        );

        await updateClient.query("COMMIT");
      } catch (error) {
        await updateClient
          .query("ROLLBACK")
          .catch(() => {});

        throw error;
      } finally {
        updateClient.release();
      }

      return res.status(202).json({
        success: true,
        message:
          status === "processed"
            ? "Paystack reports refund processed; the customer may still need to wait for bank credit."
            : "Paystack accepted the refund request. Check its status later; this is not a confirmed bank credit.",
        refund_id: refundId,
        status,
      });
    } catch (error) {
      console.error(
        "Refund provider initiation needs review:",
        error.message
      );

      await pool.query(
        `
        UPDATE goldmart_refund_attempts
        SET
          status = 'needs_review',
          updated_at = NOW()
        WHERE request_id = $1
          AND status = 'reserved'
        `,
        [requestId]
      ).catch(() => {});

      return res.status(202).json({
        success: true,
        message:
          "Refund outcome is uncertain. Do not retry. Investigate in the Paystack dashboard and reconcile the attempt.",
        requires_manual_review: true,
      });
    }
  }
);

module.exports = router;
