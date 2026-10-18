
"use strict";

// ================================================
// GOLDMART AI ADMIN
// FREE RULE-BASED ASSISTANT
// ================================================
//
// No OpenAI API key or paid AI service required.
//
// Security:
// - Authentication required
// - Authorized administrator required
// - Read-only database queries
// - No refunds, payouts, bans or changes
// - No private customer records sent anywhere
//
// ================================================

const express = require("express");
const pool = require("../db");

const { protect } = require("../middleware/auth");

const {
  requireAiAdmin,
} = require("../middleware/requireAiAdmin");

const router = express.Router();

// ================================================
// ADMIN-ONLY SECURITY
// ================================================

router.use(protect);
router.use(requireAiAdmin);

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// ================================================
// HELPERS
// ================================================

function safeCount(value) {
  const number = Number(value);

  if (
    !Number.isSafeInteger(number) ||
    number < 0
  ) {
    return 0;
  }

  return number;
}

function getCount(result, column) {
  return safeCount(
    result.rows[0]?.[column] ?? 0
  );
}

// ================================================
// GET TRUSTED MARKETPLACE DATA
// ================================================

async function buildMarketplaceReport() {
  const [
    ordersResult,
    paymentsResult,
    refundsResult,
    allocationsResult,
  ] = await Promise.all([
    // ORDERS
    pool.query(`
      SELECT
        COUNT(*) AS total_orders,

        COUNT(*) FILTER (
          WHERE status = 'processing'
        ) AS processing_orders,

        COUNT(*) FILTER (
          WHERE status = 'shipped'
        ) AS shipped_orders,

        COUNT(*) FILTER (
          WHERE status = 'delivered'
        ) AS delivered_orders,

        COUNT(*) FILTER (
          WHERE status = 'cancelled'
        ) AS cancelled_orders,

        COUNT(*) FILTER (
          WHERE created_at >= NOW() -
            INTERVAL '24 hours'
        ) AS orders_last_24_hours,

        COUNT(*) FILTER (
          WHERE status = 'processing'
          AND created_at < NOW() -
            INTERVAL '72 hours'
        ) AS processing_over_72_hours

      FROM orders
    `),

    // PAYMENT RECORDS
    pool.query(`
      SELECT
        COUNT(*) AS total_payment_records,

        COUNT(*) FILTER (
          WHERE status = 'success'
        ) AS successful_payment_records

      FROM payments
    `),

    // REFUND REQUESTS
    pool.query(`
      SELECT
        COUNT(*) AS total_refund_requests,

        COUNT(*) FILTER (
          WHERE status = 'requested'
        ) AS awaiting_review,

        COUNT(*) FILTER (
          WHERE status = 'approved'
        ) AS approved_requests,

        COUNT(*) FILTER (
          WHERE status = 'refund_pending'
        ) AS refund_pending,

        COUNT(*) FILTER (
          WHERE status = 'rejected'
        ) AS rejected_requests

      FROM goldmart_refund_requests
    `),

    // SELLER ALLOCATION RECORDS
    pool.query(`
      SELECT
        COUNT(*) AS total_allocations,

        COUNT(*) FILTER (
          WHERE status = 'pending_review'
        ) AS pending_review,

        COUNT(*) FILTER (
          WHERE status = 'blocked'
        ) AS blocked_allocations,

        COUNT(*) FILTER (
          WHERE status = 'settled'
        ) AS settled_records

      FROM seller_order_allocations
    `),
  ]);

  // ==============================================
  // BUILD DASHBOARD DATA
  // Preserve existing frontend response fields.
  // ==============================================

  const orders = {
    total: getCount(
      ordersResult,
      "total_orders"
    ),

    processing: getCount(
      ordersResult,
      "processing_orders"
    ),

    shipped: getCount(
      ordersResult,
      "shipped_orders"
    ),

    delivered: getCount(
      ordersResult,
      "delivered_orders"
    ),

    cancelled: getCount(
      ordersResult,
      "cancelled_orders"
    ),

    last_24_hours: getCount(
      ordersResult,
      "orders_last_24_hours"
    ),

    processing_over_72_hours: getCount(
      ordersResult,
      "processing_over_72_hours"
    ),
  };

  const payments = {
    total_records: getCount(
      paymentsResult,
      "total_payment_records"
    ),

    successful_records: getCount(
      paymentsResult,
      "successful_payment_records"
    ),

    note:
      "Payment records do not prove bank settlement or seller payout.",
  };

  const refunds = {
    total: getCount(
      refundsResult,
      "total_refund_requests"
    ),

    awaiting_review: getCount(
      refundsResult,
      "awaiting_review"
    ),

    approved: getCount(
      refundsResult,
      "approved_requests"
    ),

    refund_pending: getCount(
      refundsResult,
      "refund_pending"
    ),

    rejected: getCount(
      refundsResult,
      "rejected_requests"
    ),
  };

  const sellerAllocations = {
    total: getCount(
      allocationsResult,
      "total_allocations"
    ),

    pending_review: getCount(
      allocationsResult,
      "pending_review"
    ),

    blocked: getCount(
      allocationsResult,
      "blocked_allocations"
    ),

    settled_records: getCount(
      allocationsResult,
      "settled_records"
    ),

    note:
      "Seller allocation records are not withdrawable balances or proof of bank transfer.",
  };

  // ==============================================
  // OPERATIONAL ALERTS
  // These do not prove fraud or wrongdoing.
  // ==============================================

  const alerts = [];

  if (refunds.awaiting_review > 0) {
    alerts.push({
      type: "refund_review",
      severity: "attention",
      title: "Refund requests awaiting review",
      message:
        `${refunds.awaiting_review} refund request(s) ` +
        "need authorized administrator review.",
      human_review_required: true,
    });
  }

  if (refunds.refund_pending > 0) {
    alerts.push({
      type: "refund_processing",
      severity: "attention",
      title: "Refund processing requires monitoring",
      message:
        `${refunds.refund_pending} request(s) ` +
        "are recorded as refund_pending.",
      human_review_required: true,
    });
  }

  if (orders.processing_over_72_hours > 0) {
    alerts.push({
      type: "delayed_orders",
      severity: "attention",
      title: "Orders processing for over 72 hours",
      message:
        `${orders.processing_over_72_hours} order(s) ` +
        "have remained in processing for over 72 hours.",
      human_review_required: true,
    });
  }

  if (sellerAllocations.blocked > 0) {
    alerts.push({
      type: "blocked_allocations",
      severity: "information",
      title: "Seller allocations blocked",
      message:
        `${sellerAllocations.blocked} allocation(s) ` +
        "are currently blocked.",
      human_review_required: true,
    });
  }

  return {
    generated_at: new Date().toISOString(),

    overview: {
      orders,
      payments,
      refunds,
      seller_allocations: sellerAllocations,
    },

    alerts,
  };
}

// ================================================
// FREE ASSISTANT RESPONSE ENGINE
// ================================================

function buildAssistantAnswer(question, report) {
  const text = question.toLowerCase();

  const {
    orders,
    payments,
    refunds,
    seller_allocations: sellers,
  } = report.overview;

  const alerts = report.alerts;

  // ==============================================
  // HELP
  // ==============================================

  if (
    /\b(help|commands|what can you do)\b/i.test(text)
  ) {
    return [
      "I'm GoldMart's free rule-based Admin Assistant.",
      "",
      "You can ask me:",
      "",
      "• What needs my attention today?",
      "• Check my orders.",
      "• How many refund requests are pending?",
      "• Check seller allocations.",
      "• Show payment statistics.",
      "• Give me a marketplace report.",
      "",
      "I analyze database summaries. I cannot approve refunds, transfer money, ban accounts or make changes.",
    ].join("\n");
  }

  // ==============================================
  // MARKETPLACE SUMMARY / PRIORITIES
  // ==============================================

  if (
    /\b(attention|priority|priorities|problem|problems|issues?|risks?|alerts?|overview|summary|report|marketplace|today)\b/i.test(
      text
    )
  ) {
    const lines = [
      "GOLDMART MARKETPLACE REPORT",
      "",
      `Total orders: ${orders.total}`,
      `Orders created in the last 24 hours: ${orders.last_24_hours}`,
      `Processing orders: ${orders.processing}`,
      `Orders processing over 72 hours: ${orders.processing_over_72_hours}`,
      `Refunds awaiting review: ${refunds.awaiting_review}`,
      `Refunds pending processing: ${refunds.refund_pending}`,
      `Blocked seller allocations: ${sellers.blocked}`,
      "",
      "ATTENTION REQUIRED:",
    ];

    if (alerts.length === 0) {
      lines.push(
        "No issues were flagged by the current monitoring rules."
      );

      lines.push(
        "This does not guarantee that every order, payment or account is problem-free."
      );
    } else {
      alerts.forEach((alert, index) => {
        lines.push(
          `${index + 1}. ${alert.title}: ${alert.message}`
        );
      });
    }

    lines.push("");
    lines.push(
      "Recommendation: Review flagged records in GoldMart before taking any action."
    );

    lines.push(
      "Note: These are database counts. Only the new-order figure specifically covers the last 24 hours."
    );

    return lines.join("\n");
  }

  // ==============================================
  // REFUND REPORT
  // ==============================================

  if (
    /\b(refund|refunds|return|returns)\b/i.test(
      text
    )
  ) {
    return [
      "GOLDMART REFUND REPORT",
      "",
      `Total refund requests: ${refunds.total}`,
      `Awaiting review: ${refunds.awaiting_review}`,
      `Approved records: ${refunds.approved}`,
      `Refund pending: ${refunds.refund_pending}`,
      `Rejected records: ${refunds.rejected}`,
      "",
      refunds.awaiting_review > 0
        ? "Action: Check refund requests awaiting administrator review."
        : "No refund requests currently have the 'requested' status.",
      "",
      "Important: An approved or pending record does not prove a customer has received a refund.",
      "Refund decisions and processing require authorized human oversight.",
    ].join("\n");
  }

  // ==============================================
  // ORDER REPORT
  // ==============================================

  if (
    /\b(order|orders|delivery|deliveries|shipping|shipped|processing)\b/i.test(
      text
    )
  ) {
    return [
      "GOLDMART ORDER REPORT",
      "",
      `Total orders: ${orders.total}`,
      `Created in the last 24 hours: ${orders.last_24_hours}`,
      `Processing: ${orders.processing}`,
      `Shipped: ${orders.shipped}`,
      `Delivered: ${orders.delivered}`,
      `Cancelled: ${orders.cancelled}`,
      `Still processing after 72 hours: ${orders.processing_over_72_hours}`,
      "",
      orders.processing_over_72_hours > 0
        ? "Action: Review orders that have remained in processing for over 72 hours."
        : "No orders were flagged by the processing-over-72-hours rule.",
      "",
      "A processing delay alone does not prove seller misconduct.",
    ].join("\n");
  }

  // ==============================================
  // SELLER ALLOCATION REPORT
  // ==============================================

  if (
    /\b(seller|sellers|allocation|allocations|payout|payouts)\b/i.test(
      text
    )
  ) {
    return [
      "GOLDMART SELLER ALLOCATION REPORT",
      "",
      `Total allocation records: ${sellers.total}`,
      `Pending review: ${sellers.pending_review}`,
      `Blocked: ${sellers.blocked}`,
      `Recorded as settled: ${sellers.settled_records}`,
      "",
      sellers.blocked > 0
        ? "Action: Review the reason for blocked allocations."
        : "No blocked allocations are recorded.",
      "",
      "These are internal accounting records, not available seller balances.",
      "A 'settled' database status does not prove a bank transfer.",
    ].join("\n");
  }

  // ==============================================
  // PAYMENT REPORT
  // ==============================================

  if (
    /\b(payment|payments|transaction|transactions|revenue|earnings)\b/i.test(
      text
    )
  ) {
    return [
      "GOLDMART PAYMENT RECORD REPORT",
      "",
      `Total payment records: ${payments.total_records}`,
      `Records with success status: ${payments.successful_records}`,
      "",
      "These statistics reflect database statuses only.",
      "",
      "They do not confirm individual bank settlements, seller payouts or total revenue.",
      "Review verified payment records before making financial decisions.",
    ].join("\n");
  }

  // ==============================================
  // SECURITY / FRAUD QUESTIONS
  // ==============================================

  if (
    /\b(fraud|scam|scammer|suspicious|security|safe|unsafe)\b/i.test(
      text
    )
  ) {
    return [
      "GOLDMART SECURITY REVIEW",
      "",
      `Current operational alerts: ${alerts.length}`,
      `Orders processing over 72 hours: ${orders.processing_over_72_hours}`,
      `Refunds awaiting review: ${refunds.awaiting_review}`,
      `Blocked allocation records: ${sellers.blocked}`,
      "",
      "These counts cannot establish whether anyone has committed fraud.",
      "Investigate specific records using verified evidence before making a decision.",
      "Account restrictions and financial decisions require human review.",
    ].join("\n");
  }

  // ==============================================
  // UNKNOWN QUESTION
  // ==============================================

  return [
    "I can help with GoldMart's current database statistics, but I don't understand that question well enough to give a reliable answer.",
    "",
    "Try asking:",
    "",
    "• What needs my attention today?",
    "• Check my orders.",
    "• Check refund requests.",
    "• Check seller allocations.",
    "• Show payment statistics.",
    "",
    "This free version uses predefined rules and does not use a generative AI model.",
  ].join("\n");
}

// ================================================
// GET /api/ai-admin
// SERVICE INFORMATION
// ================================================

router.get("/", (req, res) => {
  return res.json({
    success: true,

    service: "GoldMart AI Admin",

    version: "2.0.0",

    mode: "read_only",

    ai_model_connected: false,

    free_assistant_available: true,

    message:
      "GoldMart AI Admin monitoring and free rule-based assistant are available.",

    administrator: {
      id: req.aiAdmin.userId,
    },

    capabilities: {
      marketplace_reports: true,
      order_monitoring: true,
      refund_monitoring: true,
      seller_allocation_monitoring: true,
      free_rule_based_assistant: true,

      autonomous_customer_support: false,
      scheduled_monitoring: false,

      approve_refunds: false,
      seller_payouts: false,
      account_bans: false,
      payment_configuration: false,
    },
  });
});

// ================================================
// GET /api/ai-admin/overview
// EXISTING DASHBOARD
// ================================================

router.get("/overview", async (req, res) => {
  try {
    const report =
      await buildMarketplaceReport();

    return res.json({
      success: true,

      service: "GoldMart AI Admin",

      mode: "read_only",

      ...report,

      security: {
        administrator_id:
          req.aiAdmin.userId,

        ai_can_change_records: false,

        financial_actions_enabled: false,

        human_approval_required: true,
      },
    });
  } catch (error) {
    console.error(
      "AI Admin overview error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to load the AI Admin overview.",
    });
  }
});

// ================================================
// POST /api/ai-admin/free-chat
// FREE RULE-BASED ASSISTANT
// ================================================

router.post("/free-chat", async (req, res) => {
  try {
    const message =
      typeof req.body?.message === "string"
        ? req.body.message.trim()
        : "";

    if (
      message.length < 2 ||
      message.length > 500
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Enter a question between 2 and 500 characters.",
      });
    }

    // Only trusted aggregate data is queried.
    const report =
      await buildMarketplaceReport();

    const answer =
      buildAssistantAnswer(message, report);

    return res.json({
      success: true,

      service: "GoldMart Free Admin Assistant",

      mode: "rule_based_read_only",

      requires_paid_ai: false,

      answer,

      generated_at:
        report.generated_at,

      financial_actions_enabled: false,
    });
  } catch (error) {
    console.error(
      "Free Admin Assistant error:",
      error.message
    );

    return res.status(500).json({
      success: false,

      message:
        "Unable to generate the free assistant report.",
    });
  }
});

// ================================================
// UNKNOWN ADMIN ROUTES
// ================================================

router.use((req, res) => {
  return res.status(404).json({
    success: false,

    message:
      "AI Admin endpoint not found.",
  });
});

module.exports = router;
