"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { finalizePaidOrder, OrderNeedsReviewError } = require("../services/finalizePaidOrder");

const base = {
  id: 22, user_id: 17, order_id: null, reference: "GM-TEST",
  amount: "15000.00", currency: "NGN", status: "success",
  checkout_snapshot: {
    schema_version: 1, order_currency: "USD",
    order_total_minor: 1000, expected_kobo: 1500000,
    delivery: { firstName: "Test" },
    items: [{ product_id: 8, seller_id: 4, quantity: 2, unit_price_minor: 500 }],
  },
};

function payment(overrides = {}) {
  return JSON.parse(JSON.stringify({ ...base, ...overrides }));
}

test("does not create orders for unconfirmed payments", async () => {
  const db = { query: async () => { throw Error("database should not be called"); } };
  await assert.rejects(finalizePaidOrder(db, payment({ status: "pending" })), OrderNeedsReviewError);
});

test("returning existing order is idempotent", async () => {
  let calls = 0;
  const db = { query: async (sql) => {
    calls++;
    assert.match(sql, /^SELECT id, user_id/);
    return { rows: [{ id: 991, user_id: 17 }] };
  }};
  const result = await finalizePaidOrder(db, payment({ order_id: 991 }));
  assert.equal(result.alreadyExists, true);
  assert.equal(result.order.id, 991);
  assert.equal(calls, 1);
});

test("reject invalid totals before writing to database", async () => {
  const db = { query: async () => { throw Error("database should not be called"); } };
  const wrong = payment();
  wrong.checkout_snapshot.order_total_minor = 900;
  await assert.rejects(finalizePaidOrder(db, wrong), OrderNeedsReviewError);
});

test("successful paid order creates stock updates, allocation and notifications", async () => {
  const queries = [];
  const db = { query: async (sql, params) => {
    queries.push({ sql, params });
    if (sql.startsWith("SELECT id, stock")) {
      return { rows: [{ id: 8, stock: 3, seller_id: 4 }] };
    }
    if (sql.startsWith("INSERT INTO orders")) {
      return { rows: [{ id: 991, user_id: 17, total_amount: "10.00", status: "processing" }] };
    }
    return { rows: [], rowCount: 1 };
  } };
  const result = await finalizePaidOrder(db, payment());
  assert.equal(result.order.id, 991);
  assert.equal(result.alreadyExists, false);
  assert.equal(queries.filter(q => q.sql.startsWith("INSERT INTO orders")).length, 1);
  assert.equal(queries.filter(q => q.sql.startsWith("UPDATE products SET stock")).length, 1);
  assert.equal(queries.filter(q => q.sql.startsWith("INSERT INTO seller_order_allocations")).length, 1);
  assert.equal(queries.filter(q => q.sql.startsWith("INSERT INTO notifications")).length, 2);
  assert.equal(queries.filter(q => q.sql.startsWith("DELETE FROM cart_items")).length, 1);
});

test("out-of-stock paid item is held for review before creating an order", async () => {
  let reads = 0;
  const db = { query: async (sql) => {
    reads++;
    assert.match(sql, /^SELECT id, stock/);
    return { rows: [{ id: 8, stock: 1, seller_id: 4 }] };
  }};
  await assert.rejects(finalizePaidOrder(db, payment()), OrderNeedsReviewError);
  assert.equal(reads, 1);
});
