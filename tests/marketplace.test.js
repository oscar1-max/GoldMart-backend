const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const request = require('supertest');
process.env.JWT_SECRET = 'isolated-tests-only-secret-with-more-than-32-characters';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_local_mock';
process.env.ENABLE_PAYSTACK_WEBHOOKS_TEST = 'true';
process.env.ENABLE_PAYSTACK_REFUNDS_TEST = 'true';
process.env.FRONTEND_URL = 'http://localhost:3000';
const db = new PGlite();
const adapter = {
  async query(sql, args) {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (!args && sql.trim().split(';').filter(x => x.trim()).length > 1) {
      await db.exec(sql); return { rows: [] };
    }
    const r = await db.query(sql, args); return { ...r, rowCount: r.affectedRows };
  },
  async connect() { return { query: (...args) => adapter.query(...args), release() {} }; }
};
require.cache[require.resolve('../db')] = { exports: adapter };
const { setupDatabase } = require('../services/databaseSetup');
const { app } = require('../server');
let buyer, seller, stranger, product, reference, orderId;
const originalFetch = global.fetch;
let providerPayment;
global.fetch = async (url, options = {}) => {
  assert.ok(String(url).startsWith('https://api.paystack.co/'), 'unexpected external request');
  if (String(url).endsWith('/transaction/initialize')) {
    const body = JSON.parse(options.body);
    providerPayment = { ...body, domain: 'test', status: 'success', currency: 'NGN' };
    return { ok: true, json: async () => ({ status: true, data: { authorization_url: 'https://checkout.paystack.com/test', reference: body.reference, access_code: 'test' } }) };
  }
  if (String(url).includes('/transaction/verify/')) return { ok: true, json: async () => ({ status: true, data: providerPayment }) };
  if (String(url).endsWith('/refund')) return { ok: true, json: async () => ({ status: true, data: { id: 901, status: 'processed', currency: 'NGN', amount: providerPayment.amount } }) };
  throw new Error('Unexpected provider endpoint: ' + url);
};
const auth = user => ({ Authorization: `Bearer ${user.token}` });
const ok = (res, status = 200) => { assert.equal(res.status, status, JSON.stringify(res.body)); return res.body; };
before(async () => { await setupDatabase(adapter); await setupDatabase(adapter); });
after(async () => { global.fetch = originalFetch; await db.close(); });
test('register, login, seller ownership and buyer/seller switching', async () => {
  const register = async (email, role) => ok(await request(app).post('/api/auth/register').send({ name: 'Test User', email, password: 'strong-test-password', role }), 201);
  buyer = await register('buyer@example.test', 'customer');
  seller = await register('seller@example.test', 'seller');
  stranger = await register('stranger@example.test', 'seller');
  process.env.ADMIN_USER_ID = String(stranger.user.id);
  ok(await request(app).post('/api/auth/login').send({ email: 'buyer@example.test', password: 'strong-test-password' }));
  product = ok(await request(app).post('/api/seller/products').set(auth(seller)).send({ name: 'Test shoes', price: 20, stock: 5, currency: 'USD' }), 201).product;
  assert.equal(ok(await request(app).get('/api/seller/products').set(auth(seller))).products.length, 1);
  assert.equal(ok(await request(app).get('/api/seller/products').set(auth(stranger))).products.length, 0);
  ok(await request(app).put(`/api/seller/products/${product.id}`).set(auth(stranger)).send({ name: 'Hijack', price: 1, stock: 1 }), 404);
  const switched = ok(await request(app).post('/api/auth/switch-role').set(auth(buyer)));
  assert.equal(switched.user.role, 'seller');
  buyer = ok(await request(app).post('/api/auth/switch-role').set(auth(switched)));
  assert.equal(buyer.user.role, 'customer');
});
test('checkout validates payment and creates one order, stock decrement and allocation', async () => {
  ok(await request(app).put('/api/cart/sync').set(auth(buyer)).send({ items: [{ productId: product.id, quantity: 2 }] }));
  const delivery = { firstName: 'Test', lastName: 'Buyer', email: 'buyer@example.test', phone: '08000000000', address: 'Test address', city: 'Test', state: 'Test' };
  const result = ok(await request(app).post('/api/payments/initialize').set(auth(buyer)).send({ email: delivery.email, currency: 'USD', amount: 40, metadata: { delivery } }));
  reference = result.reference || result.data?.reference || result.payment?.reference;
  assert.ok(reference, JSON.stringify(result));
  assert.equal(providerPayment.amount, 6000000);
  ok(await request(app).post('/api/orders').set(auth(buyer)).send({ paymentReference: reference }), 409);
  ok(await request(app).get(`/api/payments/verify/${reference}`).set(auth(stranger)), 404);
  const correct = providerPayment.amount; providerPayment.amount = 1;
  const mismatch = await request(app).get(`/api/payments/verify/${reference}`).set(auth(buyer));
  assert.notEqual(mismatch.body.payment?.status, 'success');
  providerPayment.amount = correct;
  // A mismatch stays quarantined. Start a separate test checkout.
  const fresh = ok(await request(app).post('/api/payments/initialize').set(auth(buyer)).send({ email: delivery.email, currency: 'USD', amount: 40, metadata: { delivery } }));
  reference = fresh.reference || fresh.data?.reference || fresh.payment?.reference;
  ok(await request(app).get(`/api/payments/verify/${reference}`).set(auth(buyer)));
  const order = ok(await request(app).post('/api/orders').set(auth(buyer)).send({ paymentReference: reference }), 201);
  orderId = order.order.id;
  assert.equal(ok(await request(app).post('/api/orders').set(auth(buyer)).send({ paymentReference: reference })).order.id, orderId);
  assert.equal((await db.query('SELECT stock FROM products WHERE id=$1', [product.id])).rows[0].stock, 3);
  assert.equal((await db.query('SELECT * FROM seller_order_allocations')).rows.length, 1);
});
test('notifications are private and read status persists', async () => {
  const list = ok(await request(app).get('/api/notifications').set(auth(buyer))).notifications;
  assert.ok(list.length);
  ok(await request(app).get(`/api/notifications/${buyer.user.id}`).set(auth(stranger)), 403);
  ok(await request(app).patch(`/api/notifications/${list[0].id}/read`).set(auth(buyer)));
  assert.equal(ok(await request(app).get('/api/notifications').set(auth(buyer))).notifications[0].is_read, true);
});
test('fulfillment respects ownership, progression and buyer confirmation', async () => {
  ok(await request(app).put(`/api/orders/seller/${orderId}/status`).set(auth(stranger)).send({ status: 'shipped' }), 403);
  ok(await request(app).put(`/api/orders/seller/${orderId}/status`).set(auth(seller)).send({ status: 'delivered' }), 409);
  ok(await request(app).put(`/api/orders/seller/${orderId}/status`).set(auth(seller)).send({ status: 'shipped' }));
  ok(await request(app).put(`/api/orders/seller/${orderId}/status`).set(auth(seller)).send({ status: 'delivered' }));
  ok(await request(app).post(`/api/order-protection/${orderId}/confirm-delivery`).set(auth(buyer)));
  assert.equal(ok(await request(app).post(`/api/order-protection/${orderId}/confirm-delivery`).set(auth(buyer))).already_confirmed, true);
});
test('banned users cannot switch role; outages are not expired sessions', async () => {
  await db.query('UPDATE users SET is_banned=true WHERE id=$1', [seller.user.id]);
  ok(await request(app).post('/api/auth/switch-role').set(auth(seller)), 403);
  await db.query('UPDATE users SET is_banned=false WHERE id=$1', [seller.user.id]);
  const query = adapter.query; adapter.query = async () => { throw new Error('simulated outage'); };
  try { ok(await request(app).get('/api/notifications').set(auth(buyer)), 503); }
  finally { adapter.query = query; }
});

test('refund approval requires admin, blocks seller allocation, and test refund cannot be duplicated', async () => {
  const created = ok(await request(app).post(`/api/order-protection/${orderId}/refund-request`).set(auth(buyer)).send({ reason: 'Test item does not match the description' }), 201);
  const id = created.request?.id || created.refund_request?.id;
  assert.ok(id, JSON.stringify(created));
  assert.equal((await db.query('SELECT status FROM seller_order_allocations WHERE order_id=$1', [orderId])).rows[0].status, 'blocked');
  ok(await request(app).patch(`/api/admin/refunds/${id}/review`).set(auth(buyer)).send({ decision: 'approved' }), 403);
  ok(await request(app).patch(`/api/admin/refunds/${id}/review`).set(auth(stranger)).send({ decision: 'approved' }));
  ok(await request(app).post(`/api/admin/refund-processing/${id}/start`).set(auth(stranger)), 202);
  ok(await request(app).post(`/api/admin/refund-processing/${id}/start`).set(auth(stranger)), 409);
  assert.equal((await db.query('SELECT status FROM goldmart_refund_requests WHERE id=$1', [id])).rows[0].status, 'refunded');
});

test('signed webhook finalizes multi-seller orders once; one seller cannot deliver another shipment', async () => {
  const second = ok(await request(app).post('/api/seller/products').set(auth(stranger)).send({ name: 'Second seller product', price: 10, stock: 4, currency: 'USD' }), 201).product;
  ok(await request(app).put('/api/cart/sync').set(auth(buyer)).send({ items: [{ productId: product.id, quantity: 1 }, { productId: second.id, quantity: 1 }] }));
  const delivery = { firstName: 'Test', lastName: 'Buyer', email: 'buyer@example.test', phone: '08000000000', address: 'Test address', city: 'Test', state: 'Test' };
  ok(await request(app).post('/api/payments/initialize').set(auth(buyer)).send({ email: delivery.email, currency: 'USD', amount: 30, metadata: { delivery } }));
  const event = JSON.stringify({ event: 'charge.success', data: providerPayment });
  const sign = require('node:crypto').createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(event).digest('hex');
  ok(await request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('x-paystack-signature', '0'.repeat(128)).send(event), 401);
  for (let i = 0; i < 2; i++) ok(await request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('x-paystack-signature', sign).send(event));
  const p = (await db.query('SELECT order_id FROM payments WHERE reference=$1', [providerPayment.reference])).rows[0];
  assert.ok(p.order_id);
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM order_fulfillments WHERE order_id=$1', [p.order_id])).rows[0].n, 2);
  const sellerOrders = ok(await request(app).get('/api/orders/seller/all').set(auth(seller))).orders;
  assert.equal(Number(sellerOrders.find(o => o.id === p.order_id).total_amount), 20);
  for (const status of ['shipped', 'delivered']) ok(await request(app).put(`/api/orders/seller/${p.order_id}/status`).set(auth(seller)).send({ status }));
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [p.order_id])).rows[0].status, 'processing');
  for (const status of ['shipped', 'delivered']) ok(await request(app).put(`/api/orders/seller/${p.order_id}/status`).set(auth(stranger)).send({ status }));
  assert.equal((await db.query('SELECT status FROM orders WHERE id=$1', [p.order_id])).rows[0].status, 'delivered');
});

test('chat, wishlist, reviews and support work with the reproducible schema', async () => {
  const convo = ok(await request(app).post('/api/messages/conversations').set(auth(buyer)).send({ sellerId: seller.user.id, productId: product.id }), 201).conversation;
  ok(await request(app).post(`/api/messages/conversations/${convo.id}`).set(auth(buyer)).send({ message: 'Is this test product available?' }), 201);
  const sellerNotifications = ok(await request(app).get('/api/notifications').set(auth(seller))).notifications;
  assert.ok(sellerNotifications.some(n => n.conversation_id === convo.id));
  const denied = await request(app).get(`/api/messages/conversations/${convo.id}`).set(auth(stranger));
  assert.ok([403,404].includes(denied.status));
  ok(await request(app).post('/api/wishlist').set(auth(buyer)).send({ productId: product.id }), 201);
  assert.equal(ok(await request(app).get('/api/wishlist').set(auth(buyer))).wishlist.length, 1);
  ok(await request(app).post('/api/reviews').set(auth(buyer)).send({ orderId, sellerId: seller.user.id, rating: 4, review: 'Local test review' }), 201);
  ok(await request(app).post('/api/support').set(auth(buyer)).send({ category: 'order', subject: 'Local order question', message: 'This is an isolated support test.' }), 201);
  ok(await request(app).get('/api/admin-monitoring/alerts').set(auth(stranger)));
});

test('unavailable stock never produces a partial order', async () => {
  const snapshot = { schema_version: 1, order_currency: 'USD', order_total_minor: 200000, expected_kobo: 300000000, items: [{ product_id: product.id, seller_id: seller.user.id, quantity: 100, unit_price_minor: 2000 }] };
  await db.query(`INSERT INTO payments(user_id, reference, amount, currency, status, checkout_snapshot) VALUES ($1, 'GM-out-of-stock', 3000000, 'NGN', 'success', $2)`, [buyer.user.id, JSON.stringify(snapshot)]);
  const before = (await db.query('SELECT stock FROM products WHERE id=$1', [product.id])).rows[0].stock;
  ok(await request(app).post('/api/orders').set(auth(buyer)).send({ paymentReference: 'GM-out-of-stock' }), 409);
  assert.equal((await db.query('SELECT stock FROM products WHERE id=$1', [product.id])).rows[0].stock, before);
  assert.equal((await db.query("SELECT order_id FROM payments WHERE reference='GM-out-of-stock'")).rows[0].order_id, null);
});
