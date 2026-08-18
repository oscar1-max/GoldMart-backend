const express = require("express");
const pool = require("../db");
const { protect } = require("../middleware/auth");

const router = express.Router();

// =====================================================
// GET LOGGED-IN USER'S ORDERS
// =====================================================
router.get("/", protect, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        orders.id,
        orders.total_amount,
        orders.status,
        orders.created_at
      FROM orders
      WHERE orders.user_id = $1
      ORDER BY orders.created_at DESC
      `,
      [req.user.id]
    );

    res.json({
      success: true,
      orders: result.rows,
    });
  } catch (error) {
    console.error("Get orders error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch orders",
    });
  }
});

// =====================================================
// GET ONE ORDER
// =====================================================
router.get("/:orderId", protect, async (req, res) => {
  try {
    const { orderId } = req.params;

    // Get order and make sure it belongs to logged-in user
    const orderResult = await pool.query(
      `
      SELECT
        orders.id,
        orders.user_id,
        orders.total_amount,
        orders.status,
        orders.created_at
      FROM orders
      WHERE orders.id = $1
        AND orders.user_id = $2
      `,
      [orderId, req.user.id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    // Get products inside the order
    // INCLUDING THE SELLER ID
    const itemsResult = await pool.query(
      `
      SELECT
        order_items.id,
        order_items.product_id,
        order_items.quantity,
        order_items.price,

        products.name,
        products.image_url,
        products.seller_id

      FROM order_items

      LEFT JOIN products
        ON order_items.product_id = products.id

      WHERE order_items.order_id = $1

      ORDER BY order_items.id ASC
      `,
      [orderId]
    );

    res.json({
      success: true,
      order: orderResult.rows[0],
      items: itemsResult.rows,
    });
  } catch (error) {
    console.error("Get order error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch order",
    });
  }
});

module.exports = router;
