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
    origin: "*",
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

    // Remove the old constraint if it exists.
    await pool.query(`
      ALTER TABLE seller_reviews
      DROP CONSTRAINT IF EXISTS seller_reviews_buyer_id_order_id_key;
    `);

    // Make sure one buyer can review each seller
    // only once for the same order.
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      seller_reviews_buyer_seller_order_unique
      ON seller_reviews(buyer_id, seller_id, order_id);
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

    console.log("Database setup completed successfully");
  } catch (error) {
    console.error("Database setup error:", error.message);
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
// START SERVER
// =====================================================

app.listen(PORT, async () => {
  console.log(`GoldMart API running on port ${PORT}`);

  await testDatabaseConnection();

  await setupDatabase();
});
