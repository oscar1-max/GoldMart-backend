"use strict";

// GoldMart background operations. No generative AI, payment actions,
// refunds, bans, account changes, or external messages.
// Both modes use deterministic, bounded database checks.
const pool = require("../db");

const LOCK_ID = 71019277;
const MAX_REMINDERS_PER_RUN = 20;
let schemaPromise;

function enabledOnServer() {
  return process.env.ENABLE_AI_AUTONOMY === "true";
}

function cronConfigured() {
  return String(process.env.AUTONOMY_CRON_SECRET || "").length >= 32;
}

function adminIds() {
  return [...new Set(String(process.env.ADMIN_USER_ID || "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^[1-9]\d*$/.test(part))
    .map(Number)
    .filter(Number.isSafeInteger))];
}

function permittedActions(settings) {
  if (!settings || settings.enabled !== true) return [];
  const actions = ["admin_attention_summary"];
  if (settings.mode === "advanced" && settings.seller_reminders_enabled === true) {
    actions.push("seller_order_reminders");
  }
  return actions;
}

function utcDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function utcWeekStart(now = new Date()) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return utcDate(date);
}

async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS goldmart_ai_autonomy_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          enabled BOOLEAN NOT NULL DEFAULT FALSE,
          mode TEXT NOT NULL DEFAULT 'supervised'
            CHECK (mode IN ('supervised','advanced')),
          seller_reminders_enabled BOOLEAN NOT NULL DEFAULT FALSE,
          updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        INSERT INTO goldmart_ai_autonomy_settings (id)
        VALUES (1) ON CONFLICT (id) DO NOTHING
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS goldmart_ai_autonomy_actions (
          action_key TEXT NOT NULL,
          window_key DATE NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (action_key, window_key)
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS goldmart_ai_autonomy_runs (
          id BIGSERIAL PRIMARY KEY,
          trigger_source TEXT NOT NULL,
          mode TEXT NOT NULL,
          summary JSONB NOT NULL DEFAULT '{}'::jsonb,
          ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    })().catch((error) => {
      schemaPromise = undefined;
      throw error;
    });
  }
  return schemaPromise;
}

async function getStatus() {
  await ensureSchema();
  const [settings, runs] = await Promise.all([
    pool.query("SELECT enabled,mode,seller_reminders_enabled,updated_at FROM goldmart_ai_autonomy_settings WHERE id=1"),
    pool.query("SELECT id,trigger_source,mode,summary,ran_at FROM goldmart_ai_autonomy_runs ORDER BY id DESC LIMIT 20"),
  ]);
  return {
    server_enabled: enabledOnServer(),
    cron_configured: cronConfigured(),
    settings: settings.rows[0],
    permitted_actions: permittedActions(settings.rows[0]),
    recent_runs: runs.rows,
  };
}

async function updateSettings(changes, userId) {
  await ensureSchema();
  const result = await pool.query(
    `UPDATE goldmart_ai_autonomy_settings
       SET enabled=$1,mode=$2,seller_reminders_enabled=$3,
           updated_by=$4,updated_at=NOW()
       WHERE id=1 RETURNING enabled,mode,seller_reminders_enabled,updated_at`,
    [changes.enabled, changes.mode, changes.seller_reminders_enabled, userId]
  );
  return result.rows[0];
}

// Record a once-per-window action before sending the notification.
// Everything runs in one transaction; failure rolls back the marker too.
async function claimAction(client, key, date) {
  const result = await client.query(
    "INSERT INTO goldmart_ai_autonomy_actions(action_key,window_key) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING action_key",
    [key, date]
  );
  return result.rowCount === 1;
}

async function runAutonomy(triggerSource = "manual") {
  if (!enabledOnServer()) {
    return { executed: false, reason: "Server automation is disabled (ENABLE_AI_AUTONOMY)." };
  }
  await ensureSchema();
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    const lock = await client.query("SELECT pg_try_advisory_xact_lock($1) AS acquired", [LOCK_ID]);
    if (!lock.rows[0]?.acquired) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return { executed: false, reason: "Another automation scan is running." };
    }

    const settingsResult = await client.query(
      "SELECT enabled,mode,seller_reminders_enabled FROM goldmart_ai_autonomy_settings WHERE id=1 FOR UPDATE"
    );
    const settings = settingsResult.rows[0];
    if (!settings?.enabled) {
      await client.query("COMMIT");
      inTransaction = false;
      return { executed: false, reason: "Paused by administrator." };
    }

    // The cron job may run more than once; throttle to one scan per 50 minutes.
    if (triggerSource === "cron") {
      const recent = await client.query(
        "SELECT 1 FROM goldmart_ai_autonomy_runs WHERE ran_at > NOW() - INTERVAL '50 minutes' LIMIT 1"
      );
      if (recent.rowCount) {
        await client.query("COMMIT");
        inTransaction = false;
        return { executed: false, reason: "Recently checked." };
      }
    }

    const counts = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM orders
         WHERE status='processing' AND created_at < NOW()-INTERVAL '72 hours') AS delayed_orders,
        (SELECT COUNT(*)::int FROM goldmart_refund_requests
         WHERE status='requested') AS refund_requests,
        (SELECT COUNT(*)::int FROM goldmart_withdrawal_requests
         WHERE status='pending_review') AS pending_withdrawals
    `);
    const issues = counts.rows[0];
    const summary = {
      delayed_orders: Number(issues.delayed_orders) || 0,
      refund_requests: Number(issues.refund_requests) || 0,
      pending_withdrawals: Number(issues.pending_withdrawals) || 0,
      admin_notifications: 0,
      seller_reminders: 0,
      mode: settings.mode,
    };
    const today = utcDate();
    const ids = adminIds();

    if (ids.length && (summary.delayed_orders || summary.refund_requests || summary.pending_withdrawals) &&
        await claimAction(client, "admin:attention_summary", today)) {
      const notice = await client.query(
        `INSERT INTO notifications(user_id,title,message,type,is_read)
         SELECT id,'GoldMart automatic review',$2,'admin_alert',FALSE
         FROM users WHERE id=ANY($1::integer[]) AND is_banned=FALSE`,
        [ids, "Attention needed: " + summary.delayed_orders + " delayed orders, " +
          summary.refund_requests + " refund requests, " + summary.pending_withdrawals +
          " test withdrawals pending. Review each case before taking sensitive actions."]
      );
      summary.admin_notifications = notice.rowCount;
    }

    if (permittedActions(settings).includes("seller_order_reminders")) {
      // No money movement or order-status changes. Limit and deduplicate reminders.
      const candidates = await client.query(`
        SELECT DISTINCT o.id AS order_id,p.seller_id
        FROM orders o
        JOIN order_items oi ON oi.order_id=o.id
        JOIN products p ON p.id=oi.product_id
        JOIN users u ON u.id=p.seller_id
        WHERE o.status='processing'
          AND o.created_at < NOW()-INTERVAL '72 hours'
          AND u.is_banned=FALSE
          AND p.seller_id <> ALL($1::integer[])
        ORDER BY o.id ASC,p.seller_id ASC
        LIMIT $2
      `, [ids, MAX_REMINDERS_PER_RUN]);
      const week = utcWeekStart();
      for (const item of candidates.rows) {
        const key = "seller:order:" + item.order_id + ":" + item.seller_id;
        if (!await claimAction(client, key, week)) continue;
        const result = await client.query(
          `INSERT INTO notifications(user_id,title,message,type,is_read)
           VALUES($1,'Order needs a status check',$2,'seller',FALSE)`,
          [item.seller_id, "Please review order #" + item.order_id +
            " in Seller Studio. It has been marked processing for over 72 hours. " +
            "Check its status; this reminder does not change the order."]
        );
        summary.seller_reminders += result.rowCount;
      }
    }

    await client.query(
      "INSERT INTO goldmart_ai_autonomy_runs(trigger_source,mode,summary) VALUES($1,$2,$3::jsonb)",
      [triggerSource, settings.mode, JSON.stringify(summary)]
    );
    await client.query("COMMIT");
    inTransaction = false;
    return { executed: true, summary };
  } catch (error) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  enabledOnServer, cronConfigured, permittedActions, utcWeekStart,
  ensureSchema, getStatus, updateSettings, runAutonomy,
};
