"use strict";
// Uses only a disposable local PostgreSQL database. NEVER point this at Render.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const dbUrl = process.env.GOLDMART_TEST_DATABASE_URL;
test("PostgreSQL migrations and authenticated seller/admin withdrawal flow", {
  skip: !dbUrl,
  timeout: 90000,
}, async (t) => {
  const parsed = new URL(dbUrl);
  assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname),
    "Integration tests may ONLY use a local disposable PostgreSQL database.");
  assert.equal(parsed.pathname, "/goldmart_withdrawal_test",
    "Unexpected database name; refusing to touch data.");
  process.env.DATABASE_URL = dbUrl;
  process.env.NODE_ENV = "test";
  process.env.ENABLE_SELLER_WITHDRAWALS_TEST = "true";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_local_ci_only";
  process.env.JWT_SECRET = "test-only-integration-jwt-secret";
  process.env.ADMIN_USER_ID = "3";
  process.env.PORT = "18777";

  const pool = require("../db");
  const jwt = require("jsonwebtoken");
  let child;
  let logs = "";
  t.after(async () => {
    if (child && !child.killed) child.kill("SIGTERM");
    await pool.end();
  });
  await pool.query(fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
  // Legacy refund tables predate this feature. A minimal fixture exercises
  // the existing refund guard without modifying production schemas.
  await pool.query(`CREATE TABLE goldmart_refund_requests (
    id BIGSERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    status TEXT NOT NULL DEFAULT 'requested'
  )`);
  child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", data => { logs += data.toString(); });
  child.stderr.on("data", data => { logs += data.toString(); });
  const base = "http://127.0.0.1:18777";
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(base + "/api/categories");
      const data = await response.json();
      if (response.ok && Array.isArray(data.categories)) {
        ready = true;
        break;
      }
    } catch (_) { /* Server is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(ready, "Server migrations/categories not ready. Logs: " + logs.slice(-3500));
  assert.doesNotMatch(logs, /Database setup error:/,
    "Database migrations must complete without errors.");

  await pool.query(`INSERT INTO users(id,name,email,password,role) VALUES
    (1,'Test Buyer','buyer@localhost','unused','customer'),
    (2,'Test Seller','seller@localhost','unused','seller'),
    (3,'Test Admin','admin@localhost','unused','admin'),
    (4,'Other Seller','other@localhost','unused','seller')`);
  await pool.query(`INSERT INTO orders(id,user_id,total_amount,status) VALUES
    (101,1,100,'delivered'),(102,1,100,'shipped'),
    (103,1,100,'delivered'),(104,1,100,'delivered')`);
  await pool.query(`INSERT INTO payments(id,order_id,user_id,reference,amount,currency,status) VALUES
    (301,101,1,'test-pay-101',100,'USD','success'),
    (302,102,1,'test-pay-102',100,'USD','success'),
    (303,103,1,'test-pay-103',100,'USD','success'),
    (304,104,1,'test-pay-104',100,'USD','success')`);
  await pool.query(`INSERT INTO seller_order_allocations
    (id,order_id,payment_id,seller_id,currency,gross_minor,commission_minor,seller_net_minor,status)
    VALUES
    (201,101,301,2,'USD',10000,600,9400,'pending_review'),
    (202,102,302,2,'USD',10000,600,9400,'pending_review'),
    (203,103,303,2,'USD',10000,600,9400,'pending_review'),
    (204,104,304,4,'USD',10000,600,9400,'pending_review')`);
  await pool.query(`INSERT INTO goldmart_delivery_confirmations
    (order_id,buyer_id,confirmed_at) VALUES
    (101,1,NOW()-INTERVAL '8 days'),
    (103,1,NOW()-INTERVAL '8 days'),
    (104,1,NOW()-INTERVAL '8 days')`);
  await pool.query("INSERT INTO goldmart_refund_requests(order_id,status) VALUES (103,'requested')");

  const token = id => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const tokens = { buyer: token(1), seller: token(2), admin: token(3), other: token(4) };
  async function call(method, endpoint, bearer, body) {
    const response = await fetch(base + "/api/withdrawals" + endpoint, {
      method,
      headers: {
        ...(bearer ? { Authorization: "Bearer " + bearer } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    return { status: response.status, ...data };
  }

  await t.test("seller list requires authentication and role", async () => {
    assert.equal((await call("GET", "/seller")).status, 401);
    assert.equal((await call("GET", "/seller", tokens.buyer)).status, 403);
    const response = await call("GET", "/seller", tokens.seller);
    assert.equal(response.status, 200);
    assert.equal(response.test_mode_enabled, true);
    assert.equal(response.allocations.length, 3);
    assert.equal(response.allocations.find(a => Number(a.allocation_id) === 201).eligibility.status, "approved_test");
    assert.equal(response.allocations.find(a => Number(a.allocation_id) === 203).eligibility.status, "pending_review");
  });
  await t.test("legacy allocation with missing net cannot be repaired without original payment evidence", async () => {
    await pool.query("UPDATE seller_order_allocations SET seller_net_minor=NULL WHERE id=203");
    const response=await call("POST","/seller/203/reconcile-amount",tokens.seller);
    assert.equal(response.status,409);
    assert.match(response.message,/manual review/i);
    const result=await pool.query("SELECT seller_net_minor FROM seller_order_allocations WHERE id=203");
    assert.equal(result.rows[0].seller_net_minor,null);
    await pool.query("UPDATE seller_order_allocations SET seller_net_minor=9400 WHERE id=203");
  });
  await t.test("seller cannot request another seller's allocation", async () => {
    assert.equal((await call("POST", "/seller", tokens.seller, { allocation_id: 204 })).status, 404);
    assert.equal((await call("POST", "/seller", tokens.seller, { allocation_id: "bad" })).status, 400);
  });
  let requestId;
  await t.test("safe seller request is recorded exactly once", async () => {
    const response = await call("POST", "/seller", tokens.seller, { allocation_id: 201 });
    assert.equal(response.status, 201);
    assert.equal(response.withdrawal.status, "approved_test");
    requestId = response.withdrawal.id;
    const again = await call("POST", "/seller", tokens.seller, { allocation_id: 201 });
    assert.equal(again.status, 200);
    assert.equal(again.withdrawal.id, requestId);
    const count = await pool.query("SELECT COUNT(*)::int AS count FROM goldmart_withdrawal_requests WHERE allocation_id=201");
    assert.equal(count.rows[0].count, 1);
  });
  await t.test("admin queue and hold are access controlled", async () => {
    assert.equal((await call("GET", "/admin", tokens.seller)).status, 403);
    assert.equal((await call("GET", "/admin", tokens.buyer)).status, 403);
    const queue = await call("GET", "/admin", tokens.admin);
    assert.equal(queue.status, 200);
    assert.ok(queue.withdrawals.some(w => w.id === requestId));
    assert.equal((await call("POST", "/admin/" + requestId + "/decision", tokens.admin,
      { action: "hold", note: "short" })).status, 400);
    const hold = await call("POST", "/admin/" + requestId + "/decision", tokens.admin,
      { action: "hold", note: "Checking a possible buyer dispute." });
    assert.equal(hold.status, 200);
    assert.equal(hold.withdrawal.status, "pending_review");
    assert.equal(hold.withdrawal.decision_source, "admin");
    assert.equal((await call("POST", "/seller/" + requestId + "/recheck", tokens.seller)).status, 409);
  });
  await t.test("admin approval is test-only and safety-checked", async () => {
    const response = await call("POST", "/admin/" + requestId + "/decision", tokens.admin,
      { action: "approve" });
    assert.equal(response.status, 200);
    assert.equal(response.withdrawal.status, "approved_test");
    assert.match(response.message, /No bank transfer/);
  });
  await t.test("new refund revokes automatic test approval", async () => {
    await pool.query("INSERT INTO goldmart_refund_requests(order_id,status) VALUES (101,'requested')");
    const { runWithdrawalReviews } = require("../services/withdrawalReviewWorker");
    const result = await runWithdrawalReviews();
    assert.equal(result.enabled, true);
    assert.ok(result.changed >= 1);
    const checked = await pool.query("SELECT last_auto_reviewed_at FROM goldmart_withdrawal_requests WHERE id=$1", [requestId]);
    assert.ok(checked.rows[0].last_auto_reviewed_at, "Worker must record review time to avoid queue starvation.");
    const record = await pool.query("SELECT status FROM goldmart_withdrawal_requests WHERE id=$1", [requestId]);
    assert.equal(record.rows[0].status, "pending_review");
    const retry = await call("POST", "/admin/" + requestId + "/decision", tokens.admin, { action: "approve" });
    assert.equal(retry.status, 409);
  });
  await t.test("pending delivery can become eligible; admin rejection is final", async () => {
    const created = await call("POST", "/seller", tokens.seller, { allocation_id: 202 });
    assert.equal(created.status, 201);
    assert.equal(created.withdrawal.status, "pending_review");
    await pool.query("UPDATE orders SET status='delivered' WHERE id=102");
    await pool.query("INSERT INTO goldmart_delivery_confirmations(order_id,buyer_id,confirmed_at) VALUES (102,1,NOW()-INTERVAL '8 days')");
    const { runWithdrawalReviews } = require("../services/withdrawalReviewWorker");
    await runWithdrawalReviews();
    const updated = await pool.query("SELECT status FROM goldmart_withdrawal_requests WHERE id=$1", [created.withdrawal.id]);
    assert.equal(updated.rows[0].status, "approved_test");
    const rejected = await call("POST", "/admin/" + created.withdrawal.id + "/decision", tokens.admin,
      { action: "reject", note: "This request needs an offline manual investigation." });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.withdrawal.status, "rejected");
    assert.equal((await call("POST", "/seller/" + created.withdrawal.id + "/recheck", tokens.seller)).status, 409);
    await runWithdrawalReviews();
    const still = await pool.query("SELECT status FROM goldmart_withdrawal_requests WHERE id=$1", [created.withdrawal.id]);
    assert.equal(still.rows[0].status, "rejected");
  });
  await t.test("notifications are saved, and no bank transfer is possible", async () => {
    const result = await pool.query("SELECT user_id,COUNT(*)::int AS count FROM notifications GROUP BY user_id");
    assert.ok(result.rows.some(r => r.user_id === 2 && r.count >= 2));
    assert.ok(result.rows.some(r => r.user_id === 3 && r.count >= 1));
    const statuses = await pool.query("SELECT DISTINCT status FROM goldmart_withdrawal_requests");
    assert.ok(statuses.rows.every(r => ["pending_review", "approved_test", "rejected"].includes(r.status)));
  });
});
