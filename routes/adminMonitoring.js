
"use strict";

// GOLDMART ADMIN MONITORING
// Persistent alerts + administrator notifications.
// No paid AI API.
//
// Every route requires authorized administrator access.
// No changes to payments, refunds, orders or accounts.

const express = require("express");
const pool = require("../db");

const { protect } = require("../middleware/auth");
const {
  requireAiAdmin,
} = require("../middleware/requireAiAdmin");

const router = express.Router();

router.use(protect);
router.use(requireAiAdmin);

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const SCAN_LOCK_ID = 71019201;

// ============================================
// HELPERS
// ============================================

function parseId(value) {
  const number = Number(value);

  return /^\d+$/.test(String(value)) &&
    Number.isSafeInteger(number) &&
    number > 0
    ? number
    : null;
}

function adminIds(currentAdminId) {
  const ids = String(
    process.env.ADMIN_USER_ID || ""
  )
    .split(",")
    .map((part) => Number(part.trim()))
    .filter(
      (id) =>
        Number.isSafeInteger(id) &&
        id > 0
    );

  // The current user has already passed
  // the administrator authorization check.
  return [
    ...new Set([...ids, currentAdminId]),
  ];
}

function serverError(res, action, error) {
  console.error(
    `GoldMart monitoring ${action}:`,
    error.message
  );

  return res.status(500).json({
    success: false,
    message:
      "Unable to complete the monitoring request.",
  });
}

// ============================================
// DETECT MARKETPLACE ISSUES
// ============================================

async function detectIssues(db) {
  const { rows } = await db.query(`
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

  const data = rows[0] || {};

  const get = (key) => {
    const value = Number(data[key]);

    return Number.isSafeInteger(value) &&
      value >= 0
      ? value
      : 0;
  };

  const rules = [
    [
      "refund_review",
      "attention",
      "Refund requests awaiting review",
      get("refunds_waiting"),
      "refund request(s) await administrator review",
    ],
    [
      "refund_processing",
      "attention",
      "Refund processing needs monitoring",
      get("refunds_processing"),
      "refund request(s) have refund_pending status",
    ],
    [
      "orders_over_7_days",
      "high",
      "Orders processing over 7 days",
      get("orders_over_7_days"),
      "order(s) have been processing for over 7 days",
    ],
    [
      "orders_72h_to_7d",
      "attention",
      "Orders processing for 72 hours to 7 days",
      get("orders_72h_to_7d"),
      "order(s) have been processing for 72 hours to 7 days",
    ],
    [
      "allocations_blocked",
      "attention",
      "Seller allocations blocked",
      get("allocations_blocked"),
      "seller allocation record(s) are blocked",
    ],
    [
      "allocations_waiting",
      "information",
      "Seller allocations pending review",
      get("allocations_waiting"),
      "seller allocation record(s) await review",
    ],
  ];

  return rules
    .filter(([, , , count]) => count > 0)
    .map(
      ([
        key,
        severity,
        title,
        count,
        description,
      ]) => ({
        alert_key: key,
        alert_type: key,
        severity,
        title,
        message:
          `${count} ${description}. ` +
          "Check the underlying records before acting.",
      })
    );
}

// ============================================
// ADMINISTRATOR NOTIFICATIONS
// ============================================
//
// Sends a notification when an alert is first
// detected or when a resolved alert reopens.
//
// A database SAVEPOINT protects the monitoring
// scan if the notification table has a different
// constraint or required column.
//
// ============================================

async function notifyAdmins(
  client,
  alert,
  ids
) {
  await client.query(
    "SAVEPOINT goldmart_notify"
  );

  try {
    const result = await client.query(
      `
      INSERT INTO notifications (
        user_id,
        title,
        message,
        type,
        is_read,
        created_at
      )

      SELECT
        u.id,
        $2,
        $3,
        'admin_alert',
        FALSE,
        NOW()

      FROM users u

      WHERE u.id = ANY($1::bigint[])
        AND COALESCE(
          u.is_banned,
          FALSE
        ) = FALSE

      RETURNING id
      `,
      [
        ids,
        `GoldMart alert: ${alert.title}`,
        alert.message,
      ]
    );

    await client.query(
      "RELEASE SAVEPOINT goldmart_notify"
    );

    return {
      count: result.rowCount || 0,
      error: null,
    };
  } catch (error) {
    await client.query(
      "ROLLBACK TO SAVEPOINT goldmart_notify"
    );

    await client.query(
      "RELEASE SAVEPOINT goldmart_notify"
    );

    console.error(
      "GoldMart alert notification error:",
      error.message
    );

    return {
      count: 0,
      error:
        "Alert saved, but notifications could " +
        "not be created. Check notifications " +
        "table constraints.",
    };
  }
}

// ============================================
// GET /api/admin-monitoring/alerts
// ============================================

router.get("/alerts", async (req, res) => {
  const status =
    typeof req.query.status === "string"
      ? req.query.status
      : "all";

  if (
    ![
      "all",
      "open",
      "acknowledged",
      "resolved",
    ].includes(status)
  ) {
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
        "Monitoring alerts are observations, " +
        "not proof of wrongdoing.",
    });
  } catch (error) {
    return serverError(
      res,
      "list alerts",
      error
    );
  }
});

// ============================================
// POST /api/admin-monitoring/scan
// ============================================
//
// Scans marketplace records.
// Saves or updates monitoring alerts.
// Notifies admins only for NEW or REOPENED
// alert conditions.
//
// Previously acknowledged alerts stay
// acknowledged on repeated scans.
//
// ============================================

// Inspect matching record identifiers; require administrator access.
router.get("/alerts/:id/evidence",async(req,res)=>{
  const id=parseId(req.params.id);
  if(!id)return res.status(400).json({success:false,message:"Invalid alert ID."});
  try{
    const found=await pool.query("SELECT id,alert_key,title FROM goldmart_admin_alerts WHERE id=$1",[id]);
    if(!found.rows.length)return res.status(404).json({success:false,message:"Alert not found."});
    const key=found.rows[0].alert_key;
    const queries={
      refund_review:"SELECT id,order_id,status,created_at FROM goldmart_refund_requests WHERE status='requested' ORDER BY created_at DESC LIMIT 30",
      refund_processing:"SELECT id,order_id,status,created_at FROM goldmart_refund_requests WHERE status='refund_pending' ORDER BY created_at DESC LIMIT 30",
      orders_over_7_days:"SELECT id,status,created_at FROM orders WHERE status='processing' AND created_at < NOW()-INTERVAL '7 days' ORDER BY created_at ASC LIMIT 30",
      orders_72h_to_7d:"SELECT id,status,created_at FROM orders WHERE status='processing' AND created_at < NOW()-INTERVAL '72 hours' AND created_at >= NOW()-INTERVAL '7 days' ORDER BY created_at ASC LIMIT 30",
      allocations_blocked:"SELECT id,order_id,status,created_at FROM seller_order_allocations WHERE status='blocked' ORDER BY created_at DESC LIMIT 30",
      allocations_waiting:"SELECT id,order_id,status,created_at FROM seller_order_allocations WHERE status='pending_review' ORDER BY created_at DESC LIMIT 30"
    };
    if(!Object.prototype.hasOwnProperty.call(queries,key))return res.status(404).json({success:false,message:"Record details unavailable for this alert type."});
    const records=await pool.query(queries[key]);
    return res.json({success:true,alert_key:key,records:records.rows,limited:true});
  }catch(error){return serverError(res,"alert evidence",error);}
});

router.post("/scan", async (req, res) => {
  let client;

  try {
    client = await pool.connect();

    await client.query("BEGIN");

    // Prevent simultaneous scans from producing
    // duplicate new-alert notifications.
    await client.query(
      "SELECT pg_advisory_xact_lock($1)",
      [SCAN_LOCK_ID]
    );

    const detected =
      await detectIssues(client);

    const ids = adminIds(
      req.aiAdmin.userId
    );

    let newAlerts = 0;
    let reopenedAlerts = 0;
    let notificationsCreated = 0;

    const warnings = [];

    for (const alert of detected) {
      const existing = await client.query(
        `
        SELECT status
        FROM goldmart_admin_alerts
        WHERE alert_key = $1
        FOR UPDATE
        `,
        [alert.alert_key]
      );

      const previousStatus =
        existing.rows[0]?.status;

      const newlyDetected =
        previousStatus === undefined;

      const reopened =
        previousStatus === "resolved";

      await client.query(
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
            WHEN goldmart_admin_alerts.status =
              'resolved'
            THEN 'open'
            ELSE goldmart_admin_alerts.status
          END,

          resolved_at = NULL,

          acknowledged_at = CASE
            WHEN goldmart_admin_alerts.status =
              'resolved'
            THEN NULL
            ELSE goldmart_admin_alerts.acknowledged_at
          END,

          acknowledged_by = CASE
            WHEN goldmart_admin_alerts.status =
              'resolved'
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

      if (newlyDetected || reopened) {
        if (newlyDetected) {
          newAlerts++;
        }

        if (reopened) {
          reopenedAlerts++;
        }

        const notification =
          await notifyAdmins(
            client,
            alert,
            ids
          );

        notificationsCreated +=
          notification.count;

        if (
          notification.error &&
          !warnings.includes(
            notification.error
          )
        ) {
          warnings.push(
            notification.error
          );
        }
      }
    }

    await client.query("COMMIT");

    return res.json({
      success: true,

      detected_count:
        detected.length,

      detected_alert_keys:
        detected.map(
          (alert) => alert.alert_key
        ),

      new_alerts:
        newAlerts,

      reopened_alerts:
        reopenedAlerts,

      notifications_created:
        notificationsCreated,

      warnings,

      checked_at:
        new Date().toISOString(),

      note:
        "Marketplace issues were checked. " +
        "No payment, refund, order or " +
        "account records were changed.",
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {
        // Best-effort rollback.
      }
    }

    return serverError(
      res,
      "scan",
      error
    );
  } finally {
    if (client) {
      client.release();
    }
  }
});

// ============================================
// PATCH /alerts/:id/acknowledge
// ============================================

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
            "Alert does not exist or " +
            "is no longer open.",
        });
      }

      return res.json({
        success: true,
        alert: result.rows[0],
      });
    } catch (error) {
      return serverError(
        res,
        "acknowledge",
        error
      );
    }
  }
);

// ============================================
// PATCH /alerts/:id/resolve
// ============================================
//
// Only resolve an alert after a fresh check
// confirms that its rule is no longer active.
//
// ============================================

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

    let client;

    try {
      client = await pool.connect();

      await client.query("BEGIN");

      await client.query(
        "SELECT pg_advisory_xact_lock($1)",
        [SCAN_LOCK_ID]
      );

      const existing =
        await client.query(
          `
          SELECT
            id,
            alert_key,
            status

          FROM goldmart_admin_alerts

          WHERE id = $1
          FOR UPDATE
          `,
          [id]
        );

      if (!existing.rows.length) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          message: "Alert not found.",
        });
      }

      const current =
        existing.rows[0];

      if (
        current.status === "resolved"
      ) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,
          message: "Alert already resolved.",
        });
      }

      const active =
        await detectIssues(client);

      const stillDetected =
        active.some(
          (item) =>
            item.alert_key ===
            current.alert_key
        );

      if (stillDetected) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          success: false,

          message:
            "Monitoring still detects " +
            "this issue. Review the " +
            "underlying records first.",
        });
      }

      const result =
        await client.query(
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

      await client.query("COMMIT");

      return res.json({
        success: true,

        alert: result.rows[0],

        note:
          "Monitoring alert resolved. " +
          "Underlying marketplace " +
          "records were not changed.",
      });
    } catch (error) {
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch (_) {
          // Best-effort rollback.
        }
      }

      return serverError(
        res,
        "resolve",
        error
      );
    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

module.exports = router;
