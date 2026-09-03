const express = require("express");
const cors = require("cors");
require("dotenv").config();

const routes = require("./routes");
const testDatabaseConnection = require("./database");
const pool = require("./db");

const app = express();

const PORT = process.env.PORT || 4000;

// =====================================================
// MIDDLEWARE
// =====================================================

app.use(
  cors({
    origin: true,
    credentials: true,
    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
    ],
  })
);

app.use(express.json());

// =====================================================
// DATABASE SETUP
// =====================================================

async function setupDatabase() {
  try {
    // -------------------------------------------------
    // PRODUCTS CURRENCY
    // -------------------------------------------------

    await pool.query(`
      ALTER TABLE products
      ADD COLUMN IF NOT EXISTS currency VARCHAR(3)
      NOT NULL DEFAULT 'USD';
    `);

    await pool.query(`
      UPDATE products
      SET currency = 'USD'
      WHERE currency IS NULL OR currency = '';
    `);

    // -------------------------------------------------
    // SELLER REVIEWS TABLE
    // -------------------------------------------------

    await pool.query(`
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

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // -------------------------------------------------
    // SELLER REVIEWS CONSTRAINT
    // -------------------------------------------------

    await pool.query(`
      ALTER TABLE seller_reviews
      DROP CONSTRAINT IF EXISTS
      seller_reviews_buyer_id_order_id_key;
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      seller_reviews_buyer_seller_order_unique
      ON seller_reviews(
        buyer_id,
        seller_id,
        order_id
      );
    `);

    // -------------------------------------------------
    // SELLER REVIEW INDEXES
    // -------------------------------------------------

    await pool.query(`
      CREATE INDEX IF NOT EXISTS
      seller_reviews_seller_id_idx
      ON seller_reviews(seller_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS
      seller_reviews_buyer_id_idx
      ON seller_reviews(buyer_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS
      seller_reviews_order_id_idx
      ON seller_reviews(order_id);
    `);

    // -------------------------------------------------
    // NOTIFICATIONS TABLE
    // -------------------------------------------------

    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,

        user_id INTEGER NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,

        title VARCHAR(255) NOT NULL,

        message TEXT NOT NULL,

        type VARCHAR(50)
          DEFAULT 'general',

        is_read BOOLEAN
          NOT NULL DEFAULT FALSE,

        created_at TIMESTAMP
          DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // -------------------------------------------------
    // NOTIFICATION INDEXES
    // -------------------------------------------------

    await pool.query(`
      CREATE INDEX IF NOT EXISTS
      notifications_user_id_idx
      ON notifications(user_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS
      notifications_is_read_idx
      ON notifications(is_read);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS
      notifications_created_at_idx
      ON notifications(created_at);
    `);

    // -------------------------------------------------
    // PAYMENTS TABLE
    // -------------------------------------------------

    await pool.query(`
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

        currency VARCHAR(3)
          NOT NULL DEFAULT 'NGN',

        status VARCHAR(30)
          NOT NULL DEFAULT 'pending',

        payment_method VARCHAR(50),

        created_at TIMESTAMP
          DEFAULT CURRENT_TIMESTAMP,

        updated_at TIMESTAMP
          DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // -------------------------------------------------
    // PAYMENT INDEXES
    // -------------------------------------------------

    await pool.query(`
      CREATE INDEX IF NOT EXISTS
      payments_user_id_idx
      ON payments(user_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS
      payments_order_id_idx
      ON payments(order_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS
      payments_reference_idx
      ON payments(reference);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS
      payments_status_idx
      ON payments(status);
    `);

    console.log(
      "Database setup completed successfully"
    );
  } catch (error) {
    console.error(
      "Database setup error:",
      error.message
    );
  }
}

// =====================================================
// API ROUTES
// =====================================================

app.use("/api", routes);

// =====================================================
// HOME
// =====================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "GoldMart API is running",
  });
});

// =====================================================
// HEALTH CHECK
// =====================================================

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "GoldMart backend is healthy",
  });
});

// =====================================================
// 404 HANDLER
// =====================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
    path: req.originalUrl,
  });
});

// =====================================================
// ERROR HANDLER
// =====================================================

app.use((error, req, res, next) => {
  console.error(
    "Unhandled server error:",
    error
  );

  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
});

// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, async () => {
  console.log(
    `GoldMart API running on port ${PORT}`
  );

  await testDatabaseConnection();

  await setupDatabase();
});
