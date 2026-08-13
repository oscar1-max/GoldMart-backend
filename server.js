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
    // Add currency column if it does not already exist.
    // Existing products will use USD by default.
    await pool.query(`
      ALTER TABLE products
      ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'USD';
    `);

    // Make sure existing products have a valid currency.
    await pool.query(`
      UPDATE products
      SET currency = 'USD'
      WHERE currency IS NULL OR currency = '';
    `);

    console.log("Database currency setup completed");
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
