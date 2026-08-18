const express = require("express");
const pool = require("../db");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

// =====================================================
// GET LOGGED-IN BUYER ORDERS
// =====================================================
router.get("/", protect, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        orders.id,
        orders.total_amount,
        orders.status,
        orders.created_at,

        COALESCE(
          json_agg(
            json_build_object(
              'id', order_items.id,
              'product_id', order_items.product_id,
              'quantity', order_items.quantity,
              'price', order_items.price,
              'name', products.name,
              'image_url', products.image_url,
              'seller_id', products.seller_id
            )
          ) FILTER (WHERE order_items.id IS NOT NULL),
          '[]'::json
        ) AS items

      FROM orders

      LEFT JOIN order_items
        ON orders.id = order_items.order_id

      LEFT JOIN products
        ON order_items.product_id = products.id

      WHERE orders.user_id = $1

      GROUP BY orders.id

      ORDER BY orders.created_at DESC
      `,
      [req.user.id]
    );

    res.json({
      success: true,
      orders: result.rows,
    });
  } catch (error) {
    console.error("Get buyer orders error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch orders",
    });
  }
});

// =====================================================
// SELLER — GET CUSTOMER ORDERS
// =====================================================
router.get(
  "/seller/all",
  protect,
  authorize("seller", "admin"),
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT
          orders.id,
          orders.user_id,
          orders.total_amount,
          orders.status,
          orders.created_at,

          users.name AS customer_name,
          users.email AS customer_email,

          COALESCE(
            json_agg(
              json_build_object(
                'id', order_items.id,
                'product_id', order_items.product_id,
                'product_name', products.name,
                'quantity', order_items.quantity,
                'price', order_items.price,
                'image_url', products.image_url,
                'seller_id', products.seller_id
              )
            ) FILTER (WHERE order_items.id IS NOT NULL),
            '[]'::json
          ) AS items

        FROM orders

        JOIN users
          ON orders.user_id = users.id

        JOIN order_items
          ON orders.id = order_items.order_id

        JOIN products
          ON order_items.product_id = products.id

        WHERE products.seller_id = $1

        GROUP BY
          orders.id,
          users.name,
          users.email

        ORDER BY orders.created_at DESC
        `,
        [req.user.id]
      );

      res.json({
        success: true,
        orders: result.rows,
      });
    } catch (error) {
      console.error("Get seller orders error:", error);

      res.status(500).json({
        success: false,
        message: "Failed to fetch seller orders",
      });
    }
  }
);

// =====================================================
// SELLER — UPDATE ORDER STATUS
// =====================================================
router.put(
  "/seller/:orderId/status",
  protect,
  authorize("seller", "admin"),
  async (req, res) => {
    try {
      const { orderId } = req.params;
      const { status } = req.body;

      const allowedStatuses = [
        "pending",
        "processing",
        "shipped",
        "delivered",
        "cancelled",
      ];

      if (
        !status ||
        !allowedStatuses.includes(status)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid status. Use pending, processing, shipped, delivered or cancelled.",
        });
      }

      const ownershipCheck = await pool.query(
        `
        SELECT orders.id
        FROM orders
        JOIN order_items
          ON orders.id = order_items.order_id
        JOIN products
          ON order_items.product_id = products.id
        WHERE orders.id = $1
          AND products.seller_id = $2
        LIMIT 1
        `,
        [orderId, req.user.id]
      );

      if (
        req.user.role !== "admin" &&
        ownershipCheck.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Order not found or does not belong to you",
        });
      }

      const result = await pool.query(
        `
        UPDATE orders
        SET status = $1
        WHERE id = $2
        RETURNING
          id,
          total_amount,
          status,
          created_at
        `,
        [status, orderId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Order not found",
        });
      }

      res.json({
        success: true,
        message: "Order status updated successfully",
        order: result.rows[0],
      });
    } catch (error) {
      console.error("Update order status error:", error);

      res.status(500).json({
        success: false,
        message: "Failed to update order status",
      });
    }
  }
);

// =====================================================
// BUYER — GET ONE ORDER
// =====================================================
router.get("/:orderId", protect, async (req, res) => {
  try {
    const { orderId } = req.params;

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
