ALTER TABLE products ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'USD';

UPDATE products SET currency = 'USD' WHERE currency IS NULL OR currency = '';

CREATE TABLE IF NOT EXISTS seller_reviews (
        id SERIAL PRIMARY KEY,
        buyer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
        review TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

CREATE UNIQUE INDEX IF NOT EXISTS seller_reviews_buyer_seller_order_unique
       ON seller_reviews(buyer_id, seller_id, order_id);

CREATE INDEX IF NOT EXISTS seller_reviews_seller_id_idx
       ON seller_reviews(seller_id);

CREATE INDEX IF NOT EXISTS seller_reviews_buyer_id_idx
       ON seller_reviews(buyer_id);

CREATE INDEX IF NOT EXISTS seller_reviews_order_id_idx
       ON seller_reviews(order_id);

CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        type VARCHAR(50) DEFAULT 'general',
        is_read BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

CREATE INDEX IF NOT EXISTS notifications_user_id_idx
       ON notifications(user_id);

CREATE INDEX IF NOT EXISTS notifications_is_read_idx
       ON notifications(is_read);

CREATE INDEX IF NOT EXISTS notifications_created_at_idx
       ON notifications(created_at);

CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reference VARCHAR(255) UNIQUE NOT NULL,
        amount DECIMAL(12, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL DEFAULT 'NGN',
        status VARCHAR(30) NOT NULL DEFAULT 'pending',
        payment_method VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

ALTER TABLE payments
       ADD COLUMN IF NOT EXISTS checkout_snapshot JSONB;

ALTER TABLE payments
       ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(20, 8);

CREATE INDEX IF NOT EXISTS payments_user_id_idx
       ON payments(user_id);

CREATE INDEX IF NOT EXISTS payments_order_id_idx
       ON payments(order_id);

CREATE INDEX IF NOT EXISTS payments_reference_idx
       ON payments(reference);

CREATE INDEX IF NOT EXISTS payments_status_idx
       ON payments(status);

CREATE TABLE IF NOT EXISTS seller_order_allocations (
        id BIGSERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
        payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
        seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        currency VARCHAR(3) NOT NULL CHECK (currency IN ('USD', 'NGN')),
        gross_minor BIGINT NOT NULL CHECK (gross_minor > 0),
        status VARCHAR(30) NOT NULL DEFAULT 'pending_review'
          CHECK (status IN (
            'pending_review',
            'blocked',
            'eligible',
            'settled',
            'voided'
          )),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (order_id, seller_id),
        UNIQUE (payment_id, seller_id)
      );

CREATE INDEX IF NOT EXISTS seller_order_allocations_seller_idx
       ON seller_order_allocations(seller_id);

CREATE INDEX IF NOT EXISTS seller_order_allocations_order_idx
       ON seller_order_allocations(order_id);

CREATE INDEX IF NOT EXISTS seller_order_allocations_payment_idx
       ON seller_order_allocations(payment_id);

CREATE INDEX IF NOT EXISTS seller_order_allocations_status_idx
       ON seller_order_allocations(status);

CREATE INDEX IF NOT EXISTS seller_order_allocations_seller_status_idx
       ON seller_order_allocations(seller_id, status);

ALTER TABLE users
       ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS users_is_banned_idx
       ON users(is_banned);

CREATE TABLE IF NOT EXISTS reports (
        id SERIAL PRIMARY KEY,
        reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reported_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason VARCHAR(100) NOT NULL,
        message TEXT,
        status VARCHAR(30) NOT NULL DEFAULT 'pending'
          CHECK (status IN (
            'pending',
            'reviewed',
            'resolved',
            'dismissed'
          )),
        admin_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CHECK (reporter_id <> reported_user_id)
      );

CREATE INDEX IF NOT EXISTS reports_reporter_id_idx
       ON reports(reporter_id);

CREATE INDEX IF NOT EXISTS reports_reported_user_id_idx
       ON reports(reported_user_id);

CREATE INDEX IF NOT EXISTS reports_status_idx
       ON reports(status);

CREATE INDEX IF NOT EXISTS reports_created_at_idx
       ON reports(created_at);

CREATE TABLE IF NOT EXISTS wishlist_items (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, product_id)
      );

CREATE INDEX IF NOT EXISTS wishlist_items_user_id_idx
       ON wishlist_items(user_id);

CREATE INDEX IF NOT EXISTS wishlist_items_product_id_idx
       ON wishlist_items(product_id);

CREATE INDEX IF NOT EXISTS wishlist_items_created_at_idx
       ON wishlist_items(created_at);

CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        buyer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (buyer_id, seller_id, product_id),
        CHECK (buyer_id <> seller_id)
      );

CREATE INDEX IF NOT EXISTS conversations_buyer_id_idx
       ON conversations(buyer_id);

CREATE INDEX IF NOT EXISTS conversations_seller_id_idx
       ON conversations(seller_id);

CREATE INDEX IF NOT EXISTS conversations_updated_at_idx
       ON conversations(updated_at);

CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        is_read BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

CREATE INDEX IF NOT EXISTS messages_conversation_id_idx
       ON messages(conversation_id);

CREATE INDEX IF NOT EXISTS messages_sender_id_idx
       ON messages(sender_id);

CREATE INDEX IF NOT EXISTS messages_created_at_idx
       ON messages(created_at);
