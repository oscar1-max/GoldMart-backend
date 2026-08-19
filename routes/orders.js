const express = require("express");
const pool = require("../db");
const { protect } = require("../middleware/auth");

const router = express.Router();

// =====================================================
// GET LOGGED-IN USER'S ORDERS
// =====================================================
router.get("/", protect, async (req, res) => {
  try {
    const ordersResult = await pool.query(
      `
      SELECT
        id,
        total_amount,
        status,
        created_at
      FROM orders
      WHERE user_id = $1
      ORDER BY created_at DESC
      `,
      [req.user.id]
    );

    const orders = [];

    for (const order of ordersResult.rows) {
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
        `,
        [order.id]
      );

      orders.push({
        ...order,
        items: itemsResult.rows,
      });
    }

    res.json({
      success: true,
      orders,
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
// GET ONE ORDER BELONGING TO LOGGED-IN USER
// =====================================================
router.get("/:orderId", protect, async (req, res) => {
  try {
    const { orderId } = req.params;

    const orderResult = await pool.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1
        AND user_id = $2
      `,
      [orderId, req.user.id]
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
        products.image_url,
        products.seller_id
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
