
"use strict";

// =====================================================
// GOLDMART AI ADMIN
// Stage 1 — Secure Read-Only Monitoring
// =====================================================
//
// All endpoints require:
// 1. Valid GoldMart authentication
// 2. Authorized administrator ID
//
// This file:
// - Reads marketplace summary information
// - Generates basic operational alerts
// - Does NOT approve refunds
// - Does NOT transfer money
// - Does NOT ban users
// - Does NOT change database records
// - Does NOT call an external AI model yet
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
// APPLY SECURITY TO EVERY ROUTE
// =====================================================

router.use(protect);
router.use(requireAiAdmin);

// Never cache sensitive admin responses.
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// =====================================================
// HELPERS
// =====================================================

function safeCount(value) {
  const number = Number(value);

  if (!Number.isSafeInteger(number) || number < 0) {
    return 0;
  }

  return number;
}

function getCount(result, column) {
  return safeCount(
    result.rows[0]?.[column] ?? 0
  );
}

// =====================================================
// GET /api/ai-admin
// SERVICE INFORMATION
// =====================================================

router.get("/", (req, res) => {
  return res.json({
    success: true,

    service: "GoldMart AI Admin",

    version: "1.0.0",

    mode: "read_only",

    ai_model_connected: false,

    message:
      "GoldMart AI Admin monitoring service is available.",

    administrator: {
      id: req.aiAdmin.userId,
    },

    capabilities: {
      marketplace_reports: true,
      order_monitoring: true,
      refund_monitoring: true,
      seller_allocation_monitoring: true,

      autonomous_customer_support: false,
      scheduled_monitoring: false,

      approve_refunds: false,
      seller_payouts: false,
      account_bans: false,
      payment_configuration: false,
    },
  });
});

// =====================================================
// GET /api/ai-admin/overview
// READ-ONLY MARKETPLACE DASHBOARD
// =====================================================

router.get("/overview", async (req, res) => {
  try {
    // =============================================
    // ORDER SUMMARY
    // =============================================

    const ordersResult = await pool.query(
      `
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
      `
    );

    // =============================================
    // PAYMENT SUMMARY
    //
    // These are database records only.
    // No money is moved or settled.
    // =============================================

    const paymentsResult = await pool.query(
      `
      SELECT
        COUNT(*) AS total_payment_records,

        COUNT(*) FILTER (
          WHERE status = 'success'
        ) AS successful_payment_records

      FROM payments
      `
    );

    // =============================================
    // REFUND REQUEST SUMMARY
    // =============================================

    const refundsResult = await pool.query(
      `
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
      `
    );

    // =============================================
    // SELLER ALLOCATION SUMMARY
    //
    // These represent accounting records,
    // not bank balances or withdrawable funds.
    // =============================================

    const allocationsResult = await pool.query(
      `
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
      `
    );

    // =============================================
    // FORMAT DATABASE RESULTS
    // =============================================

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
        "Payment counts do not represent seller payouts.",
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
        "Allocations are not permission to transfer seller funds.",
    };

    // =============================================
    // BASIC SECURITY-FIRST ALERTS
    //
    // Alerts describe facts or operational risks.
    // They do not prove fraud or wrongdoing.
    // =============================================

    const alerts = [];

    if (refunds.awaiting_review > 0) {
      alerts.push({
        type: "refund_review",

        severity: "attention",

        title: "Refund requests awaiting review",

        message:
          `${refunds.awaiting_review} refund request(s) ` +
          "need authorized admin review.",

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

    // =============================================
    // SEND READ-ONLY SUMMARY
    // =============================================

    return res.json({
      success: true,

      service: "GoldMart AI Admin",

      mode: "read_only",

      generated_at: new Date().toISOString(),

      overview: {
        orders,
        payments,
        refunds,

        seller_allocations:
          sellerAllocations,
      },

      alerts,

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

// =====================================================
// UNKNOWN AI ADMIN ROUTES
// =====================================================

router.use((req, res) => {
  return res.status(404).json({
    success: false,

    message:
      "AI Admin endpoint not found.",
  });
});

module.exports = router;
