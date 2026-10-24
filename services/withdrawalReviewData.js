"use strict";
const { evaluateWithdrawal } = require("./autoReviewWithdrawal");
const detailSql = [
 "SELECT a.id AS allocation_id, a.order_id, a.payment_id, a.seller_id, a.currency,",
 "a.gross_minor::text, a.commission_minor::text, a.seller_net_minor::text,",
 "a.status AS allocation_status, o.user_id AS buyer_id, o.status AS order_status,",
 "p.status AS payment_status, u.is_banned AS seller_is_banned, dc.confirmed_at AS buyer_confirmed_at,",
 "(SELECT COUNT(*)::int FROM goldmart_refund_requests r WHERE r.order_id=a.order_id) AS refund_count",
 "FROM seller_order_allocations a JOIN orders o ON o.id=a.order_id",
 "JOIN payments p ON p.id=a.payment_id JOIN users u ON u.id=a.seller_id",
 "LEFT JOIN goldmart_delivery_confirmations dc ON dc.order_id=a.order_id",
 "WHERE a.id=$1"
].join(" ");
const review = row => evaluateWithdrawal(row && {
  ...row, refund_count: row.refund_count
});
async function detail(client,id) {
  const result=await client.query(detailSql,[id]);return result.rows[0]||null;
}
async function lockOrder(client,id) {
  const lookup=await client.query("SELECT order_id FROM seller_order_allocations WHERE id=$1",[id]);
  if (!lookup.rows.length) return false;
  await client.query("SELECT id FROM orders WHERE id=$1 FOR UPDATE",[lookup.rows[0].order_id]);
  return true;
}

module.exports = { detailSql, review, detail, lockOrder };
