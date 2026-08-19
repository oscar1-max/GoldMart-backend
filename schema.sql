CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'customer',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(120) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  price DECIMAL(12, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',
  image_url TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  stock INTEGER DEFAULT 0,
  seller_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS carts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cart_items (
  id SERIAL PRIMARY KEY,
  cart_id INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 1,
  UNIQUE(cart_id, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total_amount DECIMAL(12, 2) NOT NULL,
  status VARCHAR(30) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  quantity INTEGER NOT NULL,
  price DECIMAL(12, 2) NOT NULL
);

-- =====================================================
-- SELLER REVIEWS
-- =====================================================

CREATE TABLE IF NOT EXISTS seller_reviews (
  id SERIAL PRIMARY KEY,

  buyer_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE CASCADE,

  seller_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE CASCADE,

  order_id INTEGER NOT NULL
    REFERENCES orders(id)
    ON DELETE CASCADE,

  rating INTEGER NOT NULL
    CHECK (rating >= 1 AND rating <= 5),

  review TEXT,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE (buyer_id, seller_id, order_id)
);

-- =====================================================
-- SELLER REVIEW INDEXES
-- =====================================================

CREATE INDEX IF NOT EXISTS seller_reviews_seller_id_idx
ON seller_reviews(seller_id);

CREATE INDEX IF NOT EXISTS seller_reviews_buyer_id_idx
ON seller_reviews(buyer_id);

CREATE INDEX IF NOT EXISTS seller_reviews_order_id_idx
ON seller_reviews(order_id);

-- =====================================================
-- PAYMENTS
-- =====================================================

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,

  order_id INTEGER
    REFERENCES orders(id)
    ON DELETE SET NULL,

  user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE CASCADE,

  reference VARCHAR(255) UNIQUE NOT NULL,

  amount DECIMAL(12, 2) NOT NULL,

  currency VARCHAR(3) NOT NULL DEFAULT 'USD',

  status VARCHAR(30) NOT NULL DEFAULT 'pending',

  payment_method VARCHAR(50),

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS payments_user_id_idx
ON payments(user_id);

CREATE INDEX IF NOT EXISTS payments_order_id_idx
ON payments(order_id);

CREATE INDEX IF NOT EXISTS payments_reference_idx
ON payments(reference);
