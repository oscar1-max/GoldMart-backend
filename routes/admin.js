const express = require("express");
const pool = require("../db");

const router = express.Router();

// Get all users
router.get("/users", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, name, email, role, created_at
      FROM users
      ORDER BY created_at DESC
      `
    );

    res.json({
      success: true,
      users: result.rows,
    });
  } catch (error) {
    console.error("Get users error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch users",
    });
  }
});

// Get all products
router.get("/products", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        products.*,
        categories.name AS category_name
      FROM products
      LEFT JOIN categories
        ON products.category_id = categories.id
      ORDER BY products.created_at DESC
      `
    );

    res.json({
      success: true,
      products: result.rows,
    });
  } catch (error) {
    console.error("Get admin products error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch products",
    });
  }
});

// Delete a product
router.delete("/products/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      "DELETE FROM products WHERE id = $1 RETURNING id",
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    res.json({
      success: true,
      message: "Product deleted successfully",
    });
  } catch (error) {
    console.error("Delete product error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to delete product",
    });
  }
});

module.exports = router;
