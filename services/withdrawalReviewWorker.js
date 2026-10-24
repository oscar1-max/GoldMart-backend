"use strict";
// Periodic, test-only, deterministic review. No transfers, refunds or external AI calls.
const pool = require("../db");
const { review, detail, lockOrder } = require("./withdrawalReviewData");

const enabled = () =>
  process.env.ENABLE_SELLER_WITHDRAWALS_TEST === "true" &&
  String(process.env.PAYSTACK_SECRET_KEY || "").startsWith("sk_test_");
let running = false;

async function reviewOne(requestId, allocationId) {
  const client = await pool.connect();
  let active = false;
  try {
    await client.query("BEGIN");
    active = true;
    // All fulfillment, refund and review writers must lock the order first.
    if (!(await lockOrder(client, allocationId))) {
      await client.query("ROLLBACK"); active = false; return "missing";
    }
    const result = await client.query(
      "SELECT * FROM goldmart_withdrawal_requests WHERE id=$1 FOR UPDATE",
      [requestId]
    );
    const w = result.rows[0];
    if (!w || Number(w.allocation_id) !== Number(allocationId)) {
      await client.query("ROLLBACK"); active = false; return "missing";
    }
    // Never overturn an explicit admin hold or rejection.
    if (w.status === "rejected" ||
        (w.status === "pending_review" && w.decision_source === "admin")) {
      await client.query("COMMIT"); active = false; return "held";
    }
    const decision = review(await detail(client, allocationId));
    // An automatic approval can be revoked if a new refund/ban/problem appears.
    // This also applies to previously admin-approved tests.
    if (w.status !== decision.status) {
      await client.query(
        "UPDATE goldmart_withdrawal_requests SET status=$1,decision_reason=$2,decision_source='automatic_rules',reviewed_by=NULL,updated_at=NOW() WHERE id=$3",
        [decision.status, decision.reason, requestId]
      );
      await client.query(
        "INSERT INTO notifications(user_id,title,message,type,is_read) VALUES ($1,'Withdrawal test review updated',$2,'seller',FALSE)",
        [w.seller_id, "Request #" + requestId + " is now " + decision.status.replace(/_/g, " ") + ". No bank transfer was made."]
      );
      if (decision.status === "pending_review") {
        const ids = String(process.env.ADMIN_USER_ID || "").split(",")
          .map(s => Number(s.trim())).filter(Number.isSafeInteger).filter(n => n > 0);
        if (ids.length) await client.query(
          "INSERT INTO notifications(user_id,title,message,type,is_read) SELECT id,'Withdrawal needs review',$2,'admin',FALSE FROM users WHERE id=ANY($1::integer[])",
          [ids, "Request #" + requestId + " was moved back to pending by safety checks."]
        );
      }
      await client.query("COMMIT"); active = false; return "changed";
    }
    await client.query("COMMIT"); active = false; return "unchanged";
  } catch (error) {
    if (active) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function runWithdrawalReviews(limit = 100) {
  if (!enabled()) return { enabled: false, checked: 0, changed: 0 };
  if (running) return { enabled: true, checked: 0, changed: 0, already_running: true };
  running = true;
  try {
    const count = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 100;
    const candidates = await pool.query(
      `SELECT id,allocation_id FROM goldmart_withdrawal_requests
       WHERE (status='pending_review' AND decision_source='automatic_rules')
          OR status='approved_test'
       ORDER BY updated_at ASC,id ASC LIMIT $1`, [count]
    );
    let changed = 0;
    for (const row of candidates.rows) {
      const result = await reviewOne(row.id, row.allocation_id);
      if (result === "changed") changed++;
    }
    return { enabled: true, checked: candidates.rows.length, changed };
  } finally {
    running = false;
  }
}

function startWithdrawalReviewWorker() {
  if (!enabled()) {
    console.log("GoldMart test withdrawal auto-review disabled.");
    return;
  }
  const check = () => runWithdrawalReviews().catch(error =>
    console.error("GoldMart test withdrawal auto-review:", error.message)
  );
  void check();
  const timer = setInterval(check, 60 * 60 * 1000);
  if (typeof timer.unref === "function") timer.unref();
  console.log("GoldMart test withdrawal reviews enabled (hourly while server runs).");
}
module.exports = { runWithdrawalReviews, startWithdrawalReviewWorker };
