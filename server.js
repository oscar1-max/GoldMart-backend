const express = require("express");
const cors = require("cors");
require("dotenv").config();

const routes = require("./routes");
const testDatabaseConnection = require("./database");
const pool = require("./db");

const app = express();

const PORT = process.env.PORT || 4000;

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
    // Add currency to products if it doesn't exist
    await pool.query(`
      ALTER TABLE products
      ADD COLUMN IF NOT EXISTS currency VARCHAR(3)
      NOT NULL DEFAULT 'USD';
    `);

    // Make sure old products have USD
    await pool.query(`
      UPDATE products
      SET currency = 'USD'
      WHERE currency IS NULL OR currency = '';
    `);

    // Create seller reviews table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS seller_reviews (
        id SERIAL PRIMARY KEY,
        seller_id INTEGER NOT NULL
          REFERENCES users(id) ON DELETE CASCADE,
        buyer_id INTEGER NOT NULL
          REFERENCES users(id) ON DELETE CASCADE,
        order_id INTEGER NOT NULL
          REFERENCES orders(id) ON DELETE CASCADE,
        rating INTEGER NOT NULL
          CHECK (rating >= 1 AND rating <= 5),
        review TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(buyer_id, order_id)
      );
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
