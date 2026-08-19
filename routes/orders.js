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
// GET SELLER'S CUSTOMER ORDERS
// =====================================================
router.get("/seller/all", protect, async (req, res) => {
  try {
    const sellerId = req.user.id;

    const ordersResult = await pool.query(
      `
      SELECT DISTINCT
        orders.id,
        orders.user_id,
        orders.total_amount,
        orders.status,
        orders.created_at,
        users.name AS customer_name,
        users.email AS customer_email
      FROM orders
      INNER JOIN order_items
        ON orders.id = order_items.order_id
      INNER JOIN products
        ON order_items.product_id = products.id
      INNER JOIN users
        ON orders.user_id = users.id
      WHERE products.seller_id = $1
      ORDER BY orders.created_at DESC
      `,
      [sellerId]
    );

    const orders = [];

    for (const order of ordersResult.rows) {
      const itemsResult = await pool.query(
        `
        SELECT
          order_items.id,
          order_items.product_id,
          products.name AS product_name,
          order_items.quantity,
          order_items.price,
          products.image_url
        FROM order_items
        INNER JOIN products
          ON order_items.product_id = products.id
        WHERE order_items.order_id = $1
          AND products.seller_id = $2
        ORDER BY order_items.id ASC
        `,
        [order.id, sellerId]
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
    console.error("Get seller orders error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch seller orders",
    });
  }
});

// =====================================================
// UPDATE SELLER ORDER STATUS
// =====================================================
router.put(
  "/seller/:orderId/status",
  protect,
  async (req, res) => {
    try {
      const { orderId } = req.params;
      const { status } = req.body;
      const sellerId = req.user.id;

      const allowedStatuses = [
        "pending",
        "processing",
        "shipped",
        "delivered",
        "cancelled",
      ];

      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid order status",
        });
      }

      // Make sure this order actually contains
      // at least one product belonging to this seller.
      const sellerOrderCheck = await pool.query(
        `
        SELECT orders.id
        FROM orders
        INNER JOIN order_items
          ON orders.id = order_items.order_id
        INNER JOIN products
          ON order_items.product_id = products.id
        WHERE orders.id = $1
          AND products.seller_id = $2
        LIMIT 1
        `,
        [orderId, sellerId]
      );

      if (sellerOrderCheck.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Order not found for this seller",
        });
      }

      const updatedOrder = await pool.query(
        `
        UPDATE orders
        SET status = $1
        WHERE id = $2
        RETURNING
          id,
          user_id,
          total_amount,
          status,
          created_at
        `,
        [status, orderId]
      );

      res.json({
        success: true,
        message: "Order status updated successfully",
        order: updatedOrder.rows[0],
      });
    } catch (error) {
      console.error("Update seller order status error:", error);

      res.status(500).json({
        success: false,
        message: "Failed to update order status",
      });
    }
  }
);

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
