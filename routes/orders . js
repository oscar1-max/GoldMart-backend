const express = require("express");
const pool = require("../db");

const router = express.Router();

// Get orders for a user
router.get("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

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
      [userId]
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

// Get a single order
router.get("/:userId/:orderId", async (req, res) => {
  try {
    const { userId, orderId } = req.params;

    const orderResult = await pool.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1 AND user_id = $2
      `,
      [orderId, userId]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const itemsResult = await pool.query(
      `
      SELECT
        order_items.id,
        order_items.product_id,
        order_items.quantity,
        order_items.price,
        products.name,
        products.image_url
      FROM order_items
      LEFT JOIN products
        ON order_items.product_id = products.id
      WHERE order_items.order_id = $1
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
