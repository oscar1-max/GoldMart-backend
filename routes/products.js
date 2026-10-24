const express = require("express");
const pool = require("../db");

const router = express.Router();

// Get all products
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        products.*,
        products.price AS original_price,
        CASE WHEN products.deal_price > 0 AND products.deal_price < products.price AND products.deal_start_at <= NOW() AND products.deal_end_at > NOW() THEN products.deal_price ELSE products.price END AS price,
        (products.deal_price > 0 AND products.deal_price < products.price AND products.deal_start_at <= NOW() AND products.deal_end_at > NOW()) AS is_deal,
        categories.name AS category_name,
        parent_category.name AS category_parent_name,
        products.seller_id,
        users.name AS seller_name,
        COALESCE((
          SELECT SUM(oi.quantity)
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          WHERE oi.product_id = products.id AND o.status <> 'cancelled'
        ),0)::int AS sold_count
      FROM products
      LEFT JOIN categories
        ON products.category_id = categories.id
      LEFT JOIN categories parent_category ON categories.parent_id = parent_category.id
      LEFT JOIN users
        ON products.seller_id = users.id
      WHERE products.is_active = TRUE
      ORDER BY products.id DESC
    `);

    res.json({
      success: true,
      products: result.rows,
    });
  } catch (error) {
    console.error("Get products error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch products",
    });
  }
});

// Get one product
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT
        products.*,
        products.price AS original_price,
        CASE WHEN products.deal_price > 0 AND products.deal_price < products.price AND products.deal_start_at <= NOW() AND products.deal_end_at > NOW() THEN products.deal_price ELSE products.price END AS price,
        (products.deal_price > 0 AND products.deal_price < products.price AND products.deal_start_at <= NOW() AND products.deal_end_at > NOW()) AS is_deal,
        categories.name AS category_name,
        parent_category.name AS category_parent_name,
        products.seller_id,
        users.name AS seller_name
      FROM products
      LEFT JOIN categories
        ON products.category_id = categories.id
      LEFT JOIN categories parent_category ON categories.parent_id = parent_category.id
      LEFT JOIN users
        ON products.seller_id = users.id
      WHERE products.id = $1 AND products.is_active = TRUE
      `,
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
      product: result.rows[0],
    });
  } catch (error) {
    console.error("Get product error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch product",
    });
  }
});

module.exports = router;
