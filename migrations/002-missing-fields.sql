ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_expires_at TIMESTAMP;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE seller_reviews ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS goldmart_delivery_confirmations (
 order_id INTEGER PRIMARY KEY REFERENCES orders(id),
 buyer_id INTEGER NOT NULL REFERENCES users(id),
 confirmed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS goldmart_refund_requests (
 id SERIAL PRIMARY KEY,
 order_id INTEGER NOT NULL REFERENCES orders(id),
 buyer_id INTEGER NOT NULL REFERENCES users(id),
 request_type VARCHAR(40) NOT NULL,
 reason TEXT NOT NULL,
 status VARCHAR(40) NOT NULL DEFAULT 'requested',
 review_note TEXT,
 reviewed_by INTEGER REFERENCES users(id),
 provider_status TEXT,
 paystack_refund_id TEXT,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS refund_requests_order_idx ON goldmart_refund_requests(order_id);
CREATE TABLE IF NOT EXISTS goldmart_seller_payouts (
 id SERIAL PRIMARY KEY,
 order_id INTEGER NOT NULL REFERENCES orders(id),
 seller_id INTEGER NOT NULL REFERENCES users(id),
 status VARCHAR(40) NOT NULL DEFAULT 'blocked',
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS goldmart_refund_attempts (
 id SERIAL PRIMARY KEY,
 request_id INTEGER UNIQUE NOT NULL REFERENCES goldmart_refund_requests(id),
 payment_id INTEGER NOT NULL REFERENCES payments(id),
 payment_reference TEXT NOT NULL,
 amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
 currency VARCHAR(3) NOT NULL,
 status VARCHAR(40) NOT NULL,
 started_by INTEGER NOT NULL REFERENCES users(id),
 provider_status TEXT,
 paystack_refund_id TEXT,
 error_message TEXT,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS goldmart_admin_alerts (
 id SERIAL PRIMARY KEY,
 alert_key TEXT UNIQUE NOT NULL,
 alert_type TEXT NOT NULL,
 severity TEXT NOT NULL,
 title TEXT NOT NULL,
 message TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open',
 first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 acknowledged_at TIMESTAMP,
 acknowledged_by INTEGER REFERENCES users(id),
 resolved_at TIMESTAMP,
 updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
