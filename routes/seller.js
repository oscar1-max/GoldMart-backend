const express = require("express");
const pool = require("../db");

const router = express.Router();

// Get products belonging to a seller
router.get("/:sellerId/products", async (req, res) => {
  try {
    const { sellerId } = req.params;

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
      [sellerId]
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
});

// Add a product
router.post("/:sellerId/products", async (req, res) => {
  try {
    const { sellerId } = req.params;
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

    const result = await pool.query(
      `
      INSERT INTO products
        (name, description, price, image_url, category_id, stock, seller_id)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [
        name,
        description || null,
        price,
        image_url || null,
        category_id || null,
        stock,
        sellerId,
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
});

module.exports = router;
