const pool = require("./db");

async function testDatabaseConnection() {
  try {
    const result = await pool.query("SELECT NOW() AS current_time");

    console.log("Database connected successfully.");
    console.log("Database time:", result.rows[0].current_time);

    return true;
  } catch (error) {
    console.error("Database connection failed:", error.message);

    return false;
  }
}

module.exports = testDatabaseConnection;
