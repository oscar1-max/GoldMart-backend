CREATE TABLE IF NOT EXISTS order_fulfillments (
 order_id INTEGER NOT NULL REFERENCES orders(id),
 seller_id INTEGER NOT NULL REFERENCES users(id),
 status VARCHAR(30) NOT NULL DEFAULT 'processing',
 updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(order_id, seller_id)
);
INSERT INTO order_fulfillments (order_id, seller_id, status)
SELECT DISTINCT o.id, p.seller_id, o.status
FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN products p ON p.id=oi.product_id
WHERE p.seller_id IS NOT NULL
ON CONFLICT (order_id, seller_id) DO NOTHING;
UPDATE orders o SET currency=p.checkout_snapshot->>'order_currency'
FROM payments p WHERE p.order_id=o.id AND p.checkout_snapshot->>'order_currency' IN ('USD', 'NGN');
