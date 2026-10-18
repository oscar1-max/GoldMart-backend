
"use strict";

// =====================================================
// GOLDMART ADMIN MONITORING
// FREE, RULE-BASED, ADMIN-ONLY
// =====================================================
//
// Checks run only when POST /scan is called.
// No paid AI API.
// No scheduler yet.
//
// This route manages monitoring ALERTS only.
// It never modifies orders, refunds,
// payments, sellers, or payout records.
//
// =====================================================

const express = require("express");
const pool = require("../db");

const {
  protect,
} = require("../middleware/auth");

const {
  requireAiAdmin,
} = require("../middleware/requireAiAdmin");

const router = express.Router();

// =====================================================
// SECURITY
// =====================================================

router.use(protect);
router.use(requireAiAdmin);

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// =====================================================
// DETECT CURRENT OPERATIONAL ISSUES
// =====================================================
//
// Fixed monitoring rules.
// Only aggregate counts are read.
//
// Alert keys are permanent identifiers
// for each monitoring rule.
//
// =====================================================

async function detectIssues() {
  const result = await pool.query(`
    SELECT

      (
        SELECT COUNT(*)
        FROM goldmart_refund_requests
        WHERE status = 'requested'
      ) AS refunds_waiting,

      (
        SELECT COUNT(*)
        FROM goldmart_refund_requests
        WHERE status = 'refund_pending'
      ) AS refunds_processing,

      (
        SELECT COUNT(*)
        FROM orders
        WHERE status = 'processing'
          AND created_at <
            NOW() - INTERVAL '7 days'
      ) AS orders_over_7_days,

      (
        SELECT COUNT(*)
        FROM orders
        WHERE status = 'processing'
          AND created_at <
            NOW() - INTERVAL '72 hours'
          AND created_at >=
            NOW() - INTERVAL '7 days'
      ) AS orders_72h_to_7d,

      (
        SELECT COUNT(*)
        FROM seller_order_allocations
        WHERE status = 'blocked'
      ) AS allocations_blocked,

      (
        SELECT COUNT(*)
        FROM seller_order_allocations
        WHERE status = 'pending_review'
      ) AS allocations_waiting
  `);

  const row = result.rows[0] || {};

  function count(field) {
    const value = Number(row[field]);

    return Number.isSafeInteger(value) &&
      value >= 0
      ? value
      : 0;
  }

  const rules = [
    {
      key: "refund_review",
      type: "refund_review",
      severity: "attention",
      title: "Refund requests awaiting review",
      count: count("refunds_waiting"),
      description:
        "refund request(s) await administrator review",
    },

    {
      key: "refund_processing",
      type: "refund_processing",
      severity: "attention",
      title: "Refund processing needs monitoring",
      count: count("refunds_processing"),
      description:
        "refund request(s) have refund_pending status",
    },

    {
      key: "orders_over_7_days",
      type: "very_delayed_orders",
      severity: "high",
      title: "Orders processing over 7 days",
      count: count("orders_over_7_days"),
      description:
        "order(s) have been processing for over 7 days",
    },

    {
      key: "orders_72h_to_7d",
      type: "delayed_orders",
      severity: "attention",
      title:
        "Orders processing for 72 hours to 7 days",
      count: count("orders_72h_to_7d"),
      description:
        "order(s) have been processing for 72 hours to 7 days",
    },

    {
      key: "allocations_blocked",
      type: "blocked_allocations",
      severity: "attention",
      title: "Seller allocations blocked",
      count: count("allocations_blocked"),
      description:
        "seller allocation record(s) are blocked",
    },

    {
      key: "allocations_waiting",
      type: "allocation_review",
      severity: "information",
      title: "Seller allocations pending review",
      count: count("allocations_waiting"),
      description:
        "seller allocation record(s) await review",
    },
  ];

  return rules
    .filter((rule) => rule.count > 0)
    .map((rule) => ({
      alert_key: rule.key,
      alert_type: rule.type,
      severity: rule.severity,
      title: rule.title,

      message:
        `${rule.count} ${rule.description}. ` +
        "Check the underlying records before acting.",
    }));
}

// =====================================================
// HELPERS
// =====================================================

function parseId(raw) {
  const value = Number(raw);

  if (
    !/^\d+$/.test(String(raw)) ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return null;
  }

  return value;
}

function sendError(res, context, error) {
  console.error(
    `Admin monitoring ${context}:`,
    error.message
  );

  return res.status(500).json({
    success: false,
    message:
      "Unable to complete the monitoring request.",
  });
}

// =====================================================
// GET /api/admin-monitoring/alerts
// VIEW SAVED ALERT HISTORY
// =====================================================
//
// Optional filter:
// ?status=all
// ?status=open
// ?status=acknowledged
// ?status=resolved
//
// =====================================================

router.get("/alerts", async (req, res) => {
  const status =
    typeof req.query.status === "string"
      ? req.query.status
      : "all";

  const allowedStatuses = [
    "all",
    "open",
    "acknowledged",
    "resolved",
  ];

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({
      success: false,
      message: "Invalid alert status filter.",
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT
        id,
        alert_key,
        alert_type,
        severity,
        title,
        message,
        status,
        first_seen_at,
        last_seen_at,
        acknowledged_at,
        acknowledged_by,
        resolved_at,
        updated_at

      FROM goldmart_admin_alerts

      WHERE (
        $1::text = 'all'
        OR status = $1
      )

      ORDER BY
        CASE status
          WHEN 'open' THEN 0
          WHEN 'acknowledged' THEN 1
          ELSE 2
        END,

        CASE severity
          WHEN 'high' THEN 0
          WHEN 'attention' THEN 1
          ELSE 2
        END,

        last_seen_at DESC

      LIMIT 100
      `,
      [status]
    );

    return res.json({
      success: true,
      alerts: result.rows,
      returned: result.rows.length,

      note:
        "Alerts are observations, not proof of fraud or wrongdoing.",
    });
  } catch (error) {
    return sendError(
      res,
      "list",
      error
    );
  }
});

// =====================================================
// POST /api/admin-monitoring/scan
// SCAN AND SAVE CURRENT ALERTS
// =====================================================
//
// Detects active issues and saves them.
//
// An existing acknowledged alert stays
// acknowledged during repeated scans.
//
// A resolved issue that reappears gets
// reopened.
//
// Old alerts are not automatically deleted.
//
// =====================================================

router.post("/scan", async (req, res) => {
  try {
    const detected =
      await detectIssues();

    for (const alert of detected) {
      await pool.query(
        `
        INSERT INTO goldmart_admin_alerts (
          alert_key,
          alert_type,
          severity,
          title,
          message
        )
        VALUES (
          $1, $2, $3, $4, $5
        )

        ON CONFLICT (alert_key)
        DO UPDATE SET

          alert_type =
            EXCLUDED.alert_type,

          severity =
            EXCLUDED.severity,

          title =
            EXCLUDED.title,

          message =
            EXCLUDED.message,

          last_seen_at = NOW(),

          updated_at = NOW(),

          status = CASE
            WHEN goldmart_admin_alerts.status
              = 'resolved'
            THEN 'open'
            ELSE goldmart_admin_alerts.status
          END,

          resolved_at = NULL,

          acknowledged_at = CASE
            WHEN goldmart_admin_alerts.status
              = 'resolved'
            THEN NULL
            ELSE goldmart_admin_alerts.acknowledged_at
          END,

          acknowledged_by = CASE
            WHEN goldmart_admin_alerts.status
              = 'resolved'
            THEN NULL
            ELSE goldmart_admin_alerts.acknowledged_by
          END
        `,
        [
          alert.alert_key,
          alert.alert_type,
          alert.severity,
          alert.title,
          alert.message,
        ]
      );
    }

    return res.json({
      success: true,

      detected_count:
        detected.length,

      detected_alert_keys:
        detected.map(
          (item) => item.alert_key
        ),

      checked_at:
        new Date().toISOString(),

      note:
        "Active issues were saved. " +
        "Past alerts remain available. " +
        "No orders, refunds, payouts, " +
        "or accounts were changed.",
    });
  } catch (error) {
    return sendError(
      res,
      "scan",
      error
    );
  }
});

// =====================================================
// PATCH /api/admin-monitoring/alerts/:id/acknowledge
// ADMIN ACKNOWLEDGES AN ALERT
// =====================================================
//
// Acknowledging means an administrator
// has seen the alert.
//
// It does not mean that the underlying
// issue has been fixed.
//
// =====================================================

router.patch(
  "/alerts/:id/acknowledge",
  async (req, res) => {
    const id = parseId(
      req.params.id
    );

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Invalid alert ID.",
      });
    }

    try {
      const result = await pool.query(
        `
        UPDATE goldmart_admin_alerts

        SET
          status = 'acknowledged',

          acknowledged_at = NOW(),

          acknowledged_by = $2,

          updated_at = NOW()

        WHERE id = $1
          AND status = 'open'

        RETURNING
          id,
          alert_key,
          status,
          acknowledged_at,
          acknowledged_by
        `,
        [
          id,
          req.aiAdmin.userId,
        ]
      );

      if (!result.rows.length) {
        return res.status(409).json({
          success: false,

          message:
            "This alert does not exist " +
            "or is no longer open.",
        });
      }

      return res.json({
        success: true,
        alert: result.rows[0],
      });
    } catch (error) {
      return sendError(
        res,
        "acknowledge",
        error
      );
    }
  }
);

// =====================================================
// PATCH /api/admin-monitoring/alerts/:id/resolve
// RESOLVE A MONITORING ALERT
// =====================================================
//
// Only permitted when a fresh database
// check no longer detects the same issue.
//
// This updates the alert record only.
// It never updates refunds, payments,
// orders, or seller allocations.
//
// =====================================================

router.patch(
  "/alerts/:id/resolve",
  async (req, res) => {
    const id = parseId(
      req.params.id
    );

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Invalid alert ID.",
      });
    }

    try {
      const existing =
        await pool.query(
          `
          SELECT
            id,
            alert_key,
            status

          FROM goldmart_admin_alerts

          WHERE id = $1
          `,
          [id]
        );

      if (!existing.rows.length) {
        return res.status(404).json({
          success: false,
          message: "Alert not found.",
        });
      }

      if (
        existing.rows[0].status ===
        "resolved"
      ) {
        return res.status(409).json({
          success: false,

          message:
            "Alert is already resolved.",
        });
      }

      // Check current database conditions.
      const active =
        await detectIssues();

      const stillDetected =
        active.some(
          (issue) =>
            issue.alert_key ===
            existing.rows[0].alert_key
        );

      if (stillDetected) {
        return res.status(409).json({
          success: false,

          message:
            "This issue is still detected " +
            "in marketplace records. " +
            "Review the actual issue " +
            "before resolving its alert.",
        });
      }

      const result = await pool.query(
        `
        UPDATE goldmart_admin_alerts

        SET
          status = 'resolved',

          resolved_at = NOW(),

          updated_at = NOW()

        WHERE id = $1
          AND status <> 'resolved'

        RETURNING
          id,
          alert_key,
          status,
          resolved_at
        `,
        [id]
      );

      if (!result.rows.length) {
        return res.status(409).json({
          success: false,

          message:
            "Alert status changed. Retry.",
        });
      }

      return res.json({
        success: true,
        alert: result.rows[0],

        note:
          "The monitoring alert was resolved. " +
          "No orders, payments, or refunds " +
          "were modified.",
      });
    } catch (error) {
      return sendError(
        res,
        "resolve",
        error
      );
    }
  }
);

// =====================================================
// EXPORT ROUTER
// =====================================================

module.exports = router;
