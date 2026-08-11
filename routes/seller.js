const express = require("express");
const pool = require("../db");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

// Get products belonging to the logged-in seller
router.get(
  "/products",
  protect,
  authorize("seller", "admin"),
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT
          products.*,
          categories.name AS category_name
        FROM products
        LEFT JOIN categories
          ON products.category_id = categories.id
        WHERE products.seller_id = $1
        ORDER BY products.created_at DESC
        `,
        [req.user.id]
      );

      res.json({
        success: true,
        products: result.rows,
      });
    } catch (error) {
      console.error("Get seller products error:", error);

      res.status(500).json({
        success: false,
        message: "Failed to fetch seller products",
      });
    }
  }
);

// Add a product
router.post(
  "/products",
  protect,
  authorize("seller", "admin"),
  async (req, res) => {
    try {
      const {
        name,
        description,
        price,
        image_url,
        category_id,
        stock = 0,
      } = req.body;

      if (!name || price === undefined) {
        return res.status(400).json({
          success: false,
          message: "Product name and price are required",
        });
      }

      if (Number(price) < 0) {
        return res.status(400).json({
          success: false,
          message: "Price cannot be negative",
        });
      }

      if (!Number.isInteger(Number(stock)) || Number(stock) < 0) {
        return res.status(400).json({
          success: false,
          message: "Stock must be a non-negative whole number",
        });
      }

      const result = await pool.query(
        `
        INSERT INTO products
          (name, description, price, image_url, category_id, stock, seller_id)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
        `,
        [
          name.trim(),
          description || null,
          price,
          image_url || null,
          category_id || null,
          Number(stock),
          req.user.id,
        ]
      );

      res.status(201).json({
        success: true,
        message: "Product created successfully",
        product: result.rows[0],
      });
    } catch (error) {
      console.error("Create seller product error:", error);

      res.status(500).json({
        success: false,
        message: "Failed to create product",
      });
    }
  }
);

module.exports = router;
