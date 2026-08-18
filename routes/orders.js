const express = require("express");
const pool = require("../db");
const { protect } = require("../middleware/auth");

const router = express.Router();

// =====================================================
// CREATE ORDER FROM CART
// =====================================================
router.post("/", protect, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Get user's cart
    const cartResult = await client.query(
      `
      SELECT id
      FROM carts
      WHERE user_id = $1
      `,
      [req.user.id]
    );

    if (cartResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "Your cart is empty",
      });
    }

    const cartId = cartResult.rows[0].id;

    // Get cart products
    const itemsResult = await client.query(
      `
      SELECT
        cart_items.product_id,
        cart_items.quantity,
        products.price,
        products.stock,
        products.name
      FROM cart_items
      JOIN products
        ON cart_items.product_id = products.id
      WHERE cart_items.cart_id = $1
      FOR UPDATE
      `,
      [cartId]
    );

    if (itemsResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "Your cart is empty",
      });
    }

    // Check stock and calculate total
    let totalAmount = 0;

    for (const item of itemsResult.rows) {
      if (item.stock < item.quantity) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message: `Not enough stock for ${item.name}`,
        });
      }

      totalAmount +=
        Number(item.price) * Number(item.quantity);
    }

    // Create order
    const orderResult = await client.query(
      `
      INSERT INTO orders
      (
        user_id,
        total_amount,
        status
      )
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [
        req.user.id,
        totalAmount,
        "pending",
      ]
    );

    const order = orderResult.rows[0];

    // Create order items + reduce stock
    for (const item of itemsResult.rows) {
      await client.query(
        `
        INSERT INTO order_items
        (
          order_id,
          product_id,
          quantity,
          price
        )
        VALUES ($1, $2, $3, $4)
        `,
        [
          order.id,
          item.product_id,
          item.quantity,
          item.price,
        ]
      );

      await client.query(
        `
        UPDATE products
        SET stock = stock - $1
        WHERE id = $2
        `,
        [
          item.quantity,
          item.product_id,
        ]
      );
    }

    // Empty cart
    await client.query(
      `
      DELETE FROM cart_items
      WHERE cart_id = $1
      `,
      [cartId]
    );

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Order created successfully",
      order,
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Create order error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to create order",
    });
  } finally {
    client.release();
  }
});

// =====================================================
// GET LOGGED-IN USER'S ORDERS
// =====================================================
router.get("/", protect, async (req, res) => {
  try {
    const result = await pool.query(
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
