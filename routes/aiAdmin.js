
"use strict";

// =====================================================
// GOLDMART ADMIN ASSISTANT PRO
// FREE RULE-BASED VERSION
// =====================================================
//
// No paid AI API is used.
//
// SECURITY:
// - GoldMart authentication required
// - Authorized admin access required
// - Read-only database queries
// - No refunds or transfers
// - No account bans
// - No database modifications
// - No customer personal information sent to AI
//
// =====================================================

const express = require("express");
const pool = require("../db");

const { protect } = require("../middleware/auth");

const {
  requireAiAdmin,
} = require("../middleware/requireAiAdmin");

const router = express.Router();

// =====================================================
// ADMINISTRATOR SECURITY
// =====================================================

router.use(protect);
router.use(requireAiAdmin);

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const MAX_QUESTION_LENGTH = 500;
const REQUEST_LIMIT = 12;

const recentRequests = new Map();

// =====================================================
// DATA HELPERS
// =====================================================

function safeCount(value) {
  const number = Number(value);

  return Number.isSafeInteger(number) && number >= 0
    ? number
    : 0;
}

function count(result, name) {
  return safeCount(
    result.rows[0]?.[name]
  );
}

function percent(part, whole) {
  return whole > 0
    ? Math.round((part / whole) * 100)
    : null;
}

function change(current, previous) {
  if (previous === 0) {
    return {
      direction:
        current === 0
          ? "unchanged"
          : "no_baseline",
      percent: null,
    };
  }

  const delta = Math.round(
    ((current - previous) / previous) * 100
  );

  return {
    direction:
      delta > 0
        ? "up"
        : delta < 0
          ? "down"
          : "unchanged",
    percent: delta,
  };
}

function formatTrend(current, previous, label) {
  const trend = change(current, previous);

  if (trend.percent === null) {
    return (
      `${label}: ${current} versus ${previous} ` +
      "in the preceding period " +
      "(no percentage change is calculated " +
      "from a zero baseline)."
    );
  }

  const sign =
    trend.percent > 0 ? "+" : "";

  return (
    `${label}: ${current} versus ${previous} ` +
    `in the preceding period ` +
    `(${sign}${trend.percent}%).`
  );
}

// =====================================================
// BUILD TRUSTED MARKETPLACE REPORT
// =====================================================
//
// All queries are SELECT-only.
//
// We collect aggregate counts rather than
// exposing individual customer details.
//
// =====================================================

async function buildMarketplaceReport() {
  const [
    ordersResult,
    paymentsResult,
    refundsResult,
    allocationsResult,
  ] = await Promise.all([
    // ==============================================
    // ORDERS AND ADVANCED ORDER ANALYTICS
    // ==============================================

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
          WHERE created_at >= NOW()
            - INTERVAL '24 hours'
        ) AS orders_last_24_hours,

        COUNT(*) FILTER (
          WHERE created_at >= NOW()
            - INTERVAL '48 hours'
          AND created_at < NOW()
            - INTERVAL '24 hours'
        ) AS orders_previous_24_hours,

        COUNT(*) FILTER (
          WHERE created_at >= NOW()
            - INTERVAL '7 days'
        ) AS orders_last_7_days,

        COUNT(*) FILTER (
          WHERE created_at >= NOW()
            - INTERVAL '14 days'
          AND created_at < NOW()
            - INTERVAL '7 days'
        ) AS orders_previous_7_days,

        COUNT(*) FILTER (
          WHERE status = 'processing'
          AND created_at < NOW()
            - INTERVAL '72 hours'
        ) AS processing_over_72_hours,

        COUNT(*) FILTER (
          WHERE status = 'processing'
          AND created_at < NOW()
            - INTERVAL '7 days'
        ) AS processing_over_7_days,

        COUNT(*) FILTER (
          WHERE status = 'cancelled'
          AND created_at >= NOW()
            - INTERVAL '7 days'
        ) AS recent_orders_now_cancelled

      FROM orders
    `),

    // ==============================================
    // PAYMENT RECORDS
    // ==============================================

    pool.query(`
      SELECT
        COUNT(*) AS total_payment_records,

        COUNT(*) FILTER (
          WHERE status = 'success'
        ) AS successful_payment_records

      FROM payments
    `),

    // ==============================================
    // REFUND REQUESTS
    // ==============================================

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

    // ==============================================
    // SELLER ALLOCATION RECORDS
    // ==============================================

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

  // =================================================
  // EXISTING DASHBOARD RESPONSE FIELDS
  // DO NOT CHANGE THESE NAMES.
  // =================================================

  const orders = {
    total: count(
      ordersResult,
      "total_orders"
    ),

    processing: count(
      ordersResult,
      "processing_orders"
    ),

    shipped: count(
      ordersResult,
      "shipped_orders"
    ),

    delivered: count(
      ordersResult,
      "delivered_orders"
    ),

    cancelled: count(
      ordersResult,
      "cancelled_orders"
    ),

    last_24_hours: count(
      ordersResult,
      "orders_last_24_hours"
    ),

    processing_over_72_hours: count(
      ordersResult,
      "processing_over_72_hours"
    ),
  };

  const payments = {
    total_records: count(
      paymentsResult,
      "total_payment_records"
    ),

    successful_records: count(
      paymentsResult,
      "successful_payment_records"
    ),

    note:
      "Payment records do not establish bank " +
      "settlement or seller payout.",
  };

  const refunds = {
    total: count(
      refundsResult,
      "total_refund_requests"
    ),

    awaiting_review: count(
      refundsResult,
      "awaiting_review"
    ),

    approved: count(
      refundsResult,
      "approved_requests"
    ),

    refund_pending: count(
      refundsResult,
      "refund_pending"
    ),

    rejected: count(
      refundsResult,
      "rejected_requests"
    ),
  };

  const sellerAllocations = {
    total: count(
      allocationsResult,
      "total_allocations"
    ),

    pending_review: count(
      allocationsResult,
      "pending_review"
    ),

    blocked: count(
      allocationsResult,
      "blocked_allocations"
    ),

    settled_records: count(
      allocationsResult,
      "settled_records"
    ),

    note:
      "Allocations are internal records, " +
      "not withdrawable funds or bank transfers.",
  };

  // =================================================
  // ADVANCED ANALYTICS
  // =================================================

  const last24 =
    orders.last_24_hours;

  const previous24 = count(
    ordersResult,
    "orders_previous_24_hours"
  );

  const last7 = count(
    ordersResult,
    "orders_last_7_days"
  );

  const previous7 = count(
    ordersResult,
    "orders_previous_7_days"
  );

  const over7 = count(
    ordersResult,
    "processing_over_7_days"
  );

  const recentCancelled = count(
    ordersResult,
    "recent_orders_now_cancelled"
  );

  const analytics = {
    order_activity: {
      last_24_hours: last24,

      previous_24_hours: previous24,

      last_7_days: last7,

      previous_7_days: previous7,

      change_last_24_hours:
        change(last24, previous24),

      change_last_7_days:
        change(last7, previous7),

      recent_orders_currently_cancelled:
        recentCancelled,

      recent_orders_cancelled_percent:
        percent(recentCancelled, last7),
    },

    fulfillment: {
      processing_over_72_hours:
        orders.processing_over_72_hours,

      processing_over_7_days:
        over7,

      processing_between_72_hours_and_7_days:
        Math.max(
          0,
          orders.processing_over_72_hours -
            over7
        ),
    },

    notes: [
      "Activity windows are rolling " +
        "24-hour and 7-day periods, " +
        "not calendar dates.",

      "Cancellation figures describe " +
        "the current status of orders " +
        "created in the last 7 days.",

      "Delays are based on order creation " +
        "time, not a promised delivery date.",

      "The report uses internal database " +
        "records, not independent payment " +
        "verification.",
    ],
  };

  // =================================================
  // SMART OPERATIONAL ALERTS
  // =================================================
  //
  // Alerts are ordered by priority.
  // None of these alerts proves fraud.
  //
  // =================================================

  const alerts = [];

  function addAlert(
    type,
    severity,
    title,
    message
  ) {
    alerts.push({
      type,
      severity,
      title,
      message,
      human_review_required: true,
    });
  }

  // ==============================================
  // HIGH PRIORITY — OVER 7 DAYS
  // ==============================================

  if (over7 > 0) {
    addAlert(
      "very_delayed_orders",
      "high",
      "Orders processing for more than 7 days",
      `${over7} order(s) need fulfillment ` +
        "status review. This does not " +
        "prove seller fault."
    );
  }

  // ==============================================
  // REFUNDS AWAITING REVIEW
  // ==============================================

  if (refunds.awaiting_review > 0) {
    addAlert(
      "refund_review",
      "attention",
      "Refund requests awaiting review",
      `${refunds.awaiting_review} request(s) ` +
        "need authorized human review."
    );
  }

  // ==============================================
  // REFUND PROCESSING
  // ==============================================

  if (refunds.refund_pending > 0) {
    addAlert(
      "refund_processing",
      "attention",
      "Refund processing requires monitoring",
      `${refunds.refund_pending} request(s) ` +
        "are recorded as refund_pending; " +
        "check their status."
    );
  }

  // ==============================================
  // ORDERS PROCESSING FOR 72 HOURS TO 7 DAYS
  // ==============================================

  const delayed3to7 =
    analytics.fulfillment
      .processing_between_72_hours_and_7_days;

  if (delayed3to7 > 0) {
    addAlert(
      "delayed_orders",
      "attention",
      "Orders processing for 72 hours to 7 days",
      `${delayed3to7} order(s) should have ` +
        "their fulfillment status reviewed."
    );
  }

  // ==============================================
  // BLOCKED SELLER ALLOCATIONS
  // ==============================================

  if (sellerAllocations.blocked > 0) {
    addAlert(
      "blocked_allocations",
      "attention",
      "Seller allocations blocked",
      `${sellerAllocations.blocked} ` +
        "allocation(s) are blocked. " +
        "Verify the reason before any decision."
    );
  }

  // ==============================================
  // ALLOCATIONS PENDING REVIEW
  // ==============================================

  if (sellerAllocations.pending_review > 0) {
    addAlert(
      "allocation_review",
      "information",
      "Seller allocations pending review",
      `${sellerAllocations.pending_review} ` +
        "allocation(s) are waiting for review."
    );
  }

  return {
    generated_at:
      new Date().toISOString(),

    overview: {
      orders,
      payments,
      refunds,

      seller_allocations:
        sellerAllocations,
    },

    analytics,
    alerts,
  };
}

// =====================================================
// SMART QUESTION UNDERSTANDING
// =====================================================
//
// This version can identify multiple topics
// inside one message.
//
// It uses deterministic keyword patterns,
// not a generative language model.
//
// =====================================================

function includesAny(text, patterns) {
  return patterns.some(
    (pattern) => pattern.test(text)
  );
}

function detectTopics(text) {
  return {
    orders: includesAny(text, [
      /\borders?\b/,
      /\bdeliver(?:y|ies|ed)?\b/,
      /\bshipp?(?:ing|ed|ment)?\b/,
      /\bprocessing\b/,
      /\bcancell?(?:ed|ation|ations)?\b/,
      /\bfulfill(?:ment)?\b/,
    ]),

    refunds: includesAny(text, [
      /\brefunds?\b/,
      /\breturns?\b/,
      /\bchargebacks?\b/,
      /\bdisputes?\b/,
    ]),

    sellers: includesAny(text, [
      /\bsellers?\b/,
      /\bvendors?\b/,
      /\ballocations?\b/,
      /\bpayouts?\b/,
    ]),

    payments: includesAny(text, [
      /\bpayments?\b/,
      /\btransactions?\b/,
      /\brevenue\b/,
      /\bsales\b/,
      /\bearnings?\b/,
      /\bsettlements?\b/,
      /\bprofit\b/,
    ]),

    trends: includesAny(text, [
      /\btrends?\b/,
      /\bcompare\b/,
      /\bcomparison\b/,
      /\bgrowth\b/,
      /\bweekly\b/,
      /\bweeks?\b/,
      /\blast (?:seven|7) days\b/,
      /\bprevious\b/,
      /\bperformance\b/,
      /\bincreas(?:e|ed)\b/,
      /\bdecreas(?:e|ed)\b/,
    ]),

    safety: includesAny(text, [
      /\bfraud\b/,
      /\bscams?\b/,
      /\bsuspicious\b/,
      /\bsecurity\b/,
      /\babuse\b/,
      /\bunsafe\b/,
      /\bduplicate\b/,
    ]),

    priorities: includesAny(text, [
      /\battention\b/,
      /\bpriorit(?:y|ies|ize)\b/,
      /\burgent\b/,
      /\balerts?\b/,
      /\bissues?\b/,
      /\bproblems?\b/,
      /\boverview\b/,
      /\bsummary\b/,
      /\bmarketplace\b/,
      /\breports?\b/,
      /\bwhat.*today\b/,
      /\bwhat.*focus\b/,
      /\bstats?\b/,
      /\bstatistics\b/,
      /\bcheck everything\b/,
      /\bhow.*doing\b/,
    ]),
  };
}

// =====================================================
// FORMAT ALERTS
// =====================================================

function formatAlerts(alerts) {
  if (!alerts.length) {
    return [
      "No alerts were triggered by the current rules.",
      "This does not guarantee there are no " +
        "marketplace problems.",
    ].join("\n");
  }

  return alerts
    .map(
      (alert, index) =>
        `${index + 1}. ` +
        `[${alert.severity.toUpperCase()}] ` +
        `${alert.title}: ${alert.message}`
    )
    .join("\n");
}

// =====================================================
// ADVANCED FREE ASSISTANT RESPONSE ENGINE
// =====================================================

function buildAssistantAnswer(question, report) {
  const text = question
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  const topics = detectTopics(text);

  const {
    orders,
    payments,
    refunds,
    seller_allocations: sellers,
  } = report.overview;

  const {
    order_activity: activity,
    fulfillment,
  } = report.analytics;

  const sections = [];

  // ==============================================
  // NO AUTOMATIC FINANCIAL OR ACCOUNT ACTIONS
  // ==============================================

  if (
    includesAny(text, [
      /\b(?:approve|issue|execute|initiate)\s+(?:a\s+|the\s+|all\s+)?refund/,
      /\b(?:transfer|release|send)\s+(?:money|funds|payouts?)/,
      /\b(?:pay|paying)\s+(?:the\s+|all\s+)?sellers?/,
      /\b(?:withdraw|cash out)\s+(?:seller|funds|money)/,
      /\b(?:ban|suspend|delete)\s+(?:a\s+|the\s+|all\s+)?(?:user|buyer|seller|account)/,
      /\bchange\s+(?:payment|bank|security)\s+settings/,
    ])
  ) {
    return [
      "I cannot carry out refunds, transfers, " +
        "bans, or account changes.",

      "I can provide a read-only report " +
        "for an authorized human to review.",

      "Try: 'Show refund requests awaiting review' " +
        "or 'What needs my attention?'",
    ].join("\n");
  }

  // ==============================================
  // GREETINGS
  // ==============================================

  if (
    /^(hi|hello|hey|good morning|good afternoon|good evening)[!. ]*$/.test(
      text
    )
  ) {
    return (
      "Hello! I can check GoldMart orders, " +
      "refunds, payment records, seller " +
      "allocations, 24-hour and 7-day order " +
      "trends, and operational alerts. " +
      "What would you like to review?"
    );
  }

  // ==============================================
  // HELP
  // ==============================================

  if (
    includesAny(text, [
      /\bhelp\b/,
      /\bcommands?\b/,
      /\bwhat can you do\b/,
    ])
  ) {
    return [
      "GOLDMART ADMIN ASSISTANT PRO — FREE MODE",
      "",
      "Try asking:",
      "",
      "• What needs my attention today?",
      "• Compare orders in the last 7 days " +
        "with the previous 7 days.",
      "• Check delayed orders and pending refunds.",
      "• Show order, refund and seller allocation statistics.",
      "• Are there signs of suspicious activity?",
      "",
      "I use verified aggregate database counts " +
        "and fixed rules, not a language model.",
      "",
      "I do not run in the background or " +
        "make financial/account changes.",
    ].join("\n");
  }

  const specific = [
    "orders",
    "refunds",
    "sellers",
    "payments",
    "trends",
    "safety",
  ].some((name) => topics[name]);

  // ==============================================
  // PRIORITY REVIEW
  // ==============================================

  if (
    topics.priorities &&
    !specific
  ) {
    sections.push(
      [
        "GOLDMART — PRIORITY REVIEW",
        "",
        `Total orders: ${orders.total}`,

        `New orders, rolling 24 hours: ` +
          orders.last_24_hours,

        `Refund requests awaiting review: ` +
          refunds.awaiting_review,

        `Orders processing over 72 hours: ` +
          orders.processing_over_72_hours,

        `Blocked seller allocation records: ` +
          sellers.blocked,

        "",
        "ISSUES TO CHECK (highest priority first):",
        formatAlerts(report.alerts),
      ].join("\n")
    );
  }

  // ==============================================
  // ORDER REVIEW
  // ==============================================

  if (topics.orders) {
    sections.push(
      [
        "ORDER REVIEW",
        "",
        `Total orders: ${orders.total}`,

        `Created in the past 24 hours: ` +
          orders.last_24_hours,

        `Processing: ${orders.processing}`,
        `Shipped: ${orders.shipped}`,
        `Delivered: ${orders.delivered}`,
        `Cancelled: ${orders.cancelled}`,

        `Processing for over 72 hours: ` +
          orders.processing_over_72_hours,

        `Of those, processing for over 7 days: ` +
          fulfillment.processing_over_7_days,

        "",
        "Recommendation: Review long-processing " +
          "orders individually, including their " +
          "promised delivery dates.",

        "Age alone does not establish wrongdoing.",
      ].join("\n")
    );
  }

  // ==============================================
  // REFUND REVIEW
  // ==============================================

  if (topics.refunds) {
    sections.push(
      [
        "REFUND REVIEW",
        "",
        `All recorded requests: ${refunds.total}`,
        `Awaiting review: ${refunds.awaiting_review}`,

        `Approved records: ${refunds.approved}`,

        `Refund pending: ${refunds.refund_pending}`,

        `Rejected: ${refunds.rejected}`,

        "",
        refunds.awaiting_review > 0
          ? "Recommendation: Open Admin Refunds " +
            "and review supporting evidence " +
            "for each awaiting request."
          : "No refund requests currently have " +
            "status 'requested'.",

        "",
        "Note: An approved or pending database " +
          "status does not prove that a customer " +
          "received money.",
      ].join("\n")
    );
  }

  // ==============================================
  // SELLER REVIEW
  // ==============================================

  if (topics.sellers) {
    sections.push(
      [
        "SELLER ALLOCATION REVIEW",
        "",
        `Total allocation records: ${sellers.total}`,

        `Pending review: ${sellers.pending_review}`,

        `Blocked: ${sellers.blocked}`,

        `Marked settled: ${sellers.settled_records}`,

        "",
        "Recommendation: Verify reasons for " +
          "blocked or pending allocation records " +
          "before any human decision.",

        "These are not seller wallet balances " +
          "or verified bank transfers.",
      ].join("\n")
    );
  }

  // ==============================================
  // PAYMENT RECORD REVIEW
  // ==============================================

  if (topics.payments) {
    sections.push(
      [
        "PAYMENT RECORD REVIEW",
        "",
        `Total payment records: ` +
          payments.total_records,

        `Records marked successful: ` +
          payments.successful_records,

        "",
        "This report cannot calculate verified " +
          "revenue or profits from these counts.",

        "A successful database status is " +
          "not proof of bank settlement or payout.",
      ].join("\n")
    );
  }

  // ==============================================
  // ADVANCED ORDER TREND ANALYSIS
  // ==============================================

  if (topics.trends) {
    sections.push(
      [
        "ORDER ACTIVITY TRENDS",
        "",

        formatTrend(
          activity.last_24_hours,
          activity.previous_24_hours,
          "Rolling last 24 hours"
        ),

        formatTrend(
          activity.last_7_days,
          activity.previous_7_days,
          "Rolling last 7 days"
        ),

        "",

        `Orders created in the last 7 days ` +
          `that are now cancelled: ` +
          activity.recent_orders_currently_cancelled,

        activity.recent_orders_cancelled_percent ===
        null
          ? "No recent orders to calculate a " +
            "cancellation percentage."
          : "Current cancellation proportion " +
            `among those orders: ` +
            `${activity.recent_orders_cancelled_percent}%.`,

        "",
        "This is an activity comparison, " +
          "not a revenue or fraud prediction.",

        "Time windows are rolling periods, " +
          "not local calendar days.",
      ].join("\n")
    );
  }

  // ==============================================
  // SECURITY REVIEW
  // ==============================================

  if (topics.safety) {
    sections.push(
      [
        "OPERATIONAL RISK REVIEW",
        "",

        `Current rule-based alerts: ` +
          report.alerts.length,

        `Processing over 7 days: ` +
          fulfillment.processing_over_7_days,

        `Refunds awaiting review: ` +
          refunds.awaiting_review,

        `Blocked allocation records: ` +
          sellers.blocked,

        "",
        "These aggregate counts cannot identify " +
          "a scammer, duplicate refund, " +
          "or fraudulent account.",

        "Investigate case-level evidence " +
          "before considering any account " +
          "or financial action.",
      ].join("\n")
    );
  }

  // ==============================================
  // UNKNOWN QUESTION
  // ==============================================

  if (!sections.length) {
    return [
      "I cannot reliably answer that question " +
        "using the aggregate data available " +
        "in free mode.",

      "",
      "I can explain orders, refunds, seller " +
        "allocation records, payment status counts, " +
        "recent order trends, and operational alerts.",

      "",
      "Try: 'Compare orders over the last " +
        "7 days and check pending refunds.'",

      "",
      "I cannot look up personal details, " +
        "individual transaction evidence, " +
        "or unrelated topics.",
    ].join("\n");
  }

  // ==============================================
  // INCLUDE PRIORITY ALERTS IN MIXED QUESTIONS
  // ==============================================

  if (
    topics.priorities &&
    specific
  ) {
    sections.push(
      "PRIORITY ALERTS\n" +
        formatAlerts(report.alerts)
    );
  }

  sections.push(
    "Report created: " +
      report.generated_at +
      " (UTC).",

    "Read-only and rule-based: recommendations " +
      "need authorized human review."
  );

  return sections.join("\n\n");
}

// =====================================================
// FREE REQUEST LIMITER
// =====================================================
//
// Prevents excessive repeated database queries.
//
// This limit applies per admin, per minute,
// inside the current server process.
//
// =====================================================

function withinRateLimit(userId) {
  const now = Date.now();

  const history = (
    recentRequests.get(userId) || []
  ).filter(
    (timestamp) =>
      now - timestamp < 60000
  );

  if (
    history.length >= REQUEST_LIMIT
  ) {
    recentRequests.set(
      userId,
      history
    );

    return false;
  }

  history.push(now);

  recentRequests.set(
    userId,
    history
  );

  return true;
}

// =====================================================
// GET /api/ai-admin
// SERVICE INFORMATION
// =====================================================

router.get("/", (req, res) => {
  return res.json({
    success: true,

    service: "GoldMart AI Admin",

    version: "3.0.0",

    mode: "rule_based_read_only",

    ai_model_connected: false,

    free_assistant_available: true,

    administrator: {
      id: req.aiAdmin.userId,
    },

    message:
      "GoldMart Admin Assistant Pro " +
      "is available without an AI API.",

    capabilities: {
      marketplace_reports: true,
      order_monitoring: true,
      refund_monitoring: true,
      seller_allocation_monitoring: true,
      free_rule_based_assistant: true,
      order_trends: true,
      alert_prioritization: true,

      scheduled_monitoring: false,
      autonomous_customer_support: false,

      approve_refunds: false,
      seller_payouts: false,
      account_bans: false,
      payment_configuration: false,
    },
  });
});

// =====================================================
// GET /api/ai-admin/overview
// PRESERVES EXISTING DASHBOARD FIELDS
// =====================================================

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
      "GoldMart AI Admin overview error:",
      error.message
    );

    return res.status(500).json({
      success: false,

      message:
        "Unable to load the AI Admin overview.",
    });
  }
});

// =====================================================
// POST /api/ai-admin/free-chat
// SMARTER FREE ASSISTANT
// =====================================================

router.post(
  "/free-chat",
  async (req, res) => {
    try {
      const message =
        typeof req.body?.message === "string"
          ? req.body.message.trim()
          : "";

      if (
        message.length < 2 ||
        message.length > MAX_QUESTION_LENGTH
      ) {
        return res.status(400).json({
          success: false,

          message:
            "Enter a question between " +
            "2 and 500 characters.",
        });
      }

      if (
        !withinRateLimit(req.aiAdmin.userId)
      ) {
        return res.status(429).json({
          success: false,

          message:
            "Too many requests. " +
            "Please wait one minute.",
        });
      }

      const report =
        await buildMarketplaceReport();

      const answer =
        buildAssistantAnswer(
          message,
          report
        );

      return res.json({
        success: true,

        service:
          "GoldMart Free Admin Assistant Pro",

        mode: "rule_based_read_only",

        requires_paid_ai: false,

        answer,

        analysis: {
          order_activity:
            report.analytics.order_activity,

          fulfillment:
            report.analytics.fulfillment,

          alert_count:
            report.alerts.length,
        },

        generated_at:
          report.generated_at,

        financial_actions_enabled: false,
      });
    } catch (error) {
      console.error(
        "GoldMart free assistant error:",
        error.message
      );

      return res.status(500).json({
        success: false,

        message:
          "Unable to generate the " +
          "free assistant report.",
      });
    }
  }
);

// =====================================================
// UNKNOWN ADMIN ENDPOINTS
// =====================================================

router.use((req, res) => {
  return res.status(404).json({
    success: false,

    message:
      "AI Admin endpoint not found.",
  });
});

module.exports = router;
