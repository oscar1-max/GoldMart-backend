const express = require("express");
const pool = require("../db");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

const ALLOWED_CURRENCIES = ["USD", "NGN", "EUR", "GBP"];

// =====================================================
// GET ALL SELLER PRODUCTS
// =====================================================
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

// =====================================================
// GET ONE SELLER PRODUCT
// =====================================================
router.get(
  "/products/:id",
  protect,
  authorize("seller", "admin"),
  async (req, res) => {
    try {
      const { id } = req.params;

      let result;

      if (req.user.role === "admin") {
        result = await pool.query(
          `
          SELECT
            products.*,
            categories.name AS category_name
          FROM products
          LEFT JOIN categories
            ON products.category_id = categories.id
          WHERE products.id = $1
          `,
          [id]
        );
      } else {
        result = await pool.query(
          `
          SELECT
            products.*,
            categories.name AS category_name
          FROM products
          LEFT JOIN categories
            ON products.category_id = categories.id
          WHERE products.id = $1
            AND products.seller_id = $2
          `,
          [id, req.user.id]
        );
      }

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Product not found or you do not own this product",
        });
      }

      res.json({
        success: true,
        product: result.rows[0],
      });
    } catch (error) {
      console.error("Get seller product error:", error);

      res.status(500).json({
        success: false,
        message: "Failed to fetch product",
      });
    }
  }
);

// =====================================================
// ADD SELLER PRODUCT
// =====================================================
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
        currency = "USD",
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

      const numericPrice = Number(price);
      const numericStock = Number(stock);
      const productCurrency = String(currency).toUpperCase();

      if (!Number.isFinite(numericPrice) || numericPrice < 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid product price",
        });
      }

      if (!ALLOWED_CURRENCIES.includes(productCurrency)) {
        return res.status(400).json({
          success: false,
          message: "Invalid currency. Use USD, NGN, EUR or GBP.",
        });
      }

      if (!Number.isInteger(numericStock) || numericStock < 0) {
        return res.status(400).json({
          success: false,
          message: "Stock must be a non-negative whole number",
        });
      }

      const result = await pool.query(
        `
        INSERT INTO products
        (
          name,
          description,
          price,
          image_url,
          category_id,
          stock,
          seller_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
        `,
        [
          name.trim(),
          description?.trim() || null,
          numericPrice,
          image_url || null,
          category_id || null,
          numericStock,
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
        message: error.message || "Failed to create product",
      });
    }
  }
);

// =====================================================
// UPDATE SELLER PRODUCT
// =====================================================
router.put(
  "/products/:id",
  protect,
  authorize("seller", "admin"),
  async (req, res) => {
    try {
      const { id } = req.params;

      const {
        name,
        description,
        price,
        image_url,
        category_id,
        stock,
      } = req.body;

      if (!name || price === undefined || stock === undefined) {
        return res.status(400).json({
          success: false,
          message: "Product name, price and stock are required",
        });
      }

      const numericPrice = Number(price);
      const numericStock = Number(stock);

      if (!Number.isFinite(numericPrice) || numericPrice < 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid product price",
        });
      }

      if (!Number.isInteger(numericStock) || numericStock < 0) {
        return res.status(400).json({
          success: false,
          message: "Stock must be a non-negative whole number",
        });
      }

      let result;

      if (req.user.role === "admin") {
        result = await pool.query(
          `
          UPDATE products
          SET
            name = $1,
            description = $2,
            price = $3,
            image_url = $4,
            category_id = $5,
            stock = $6
          WHERE id = $7
          RETURNING *
          `,
          [
            name.trim(),
            description?.trim() || null,
            numericPrice,
            image_url || null,
            category_id || null,
            numericStock,
            id,
          ]
        );
      } else {
        result = await pool.query(
          `
          UPDATE products
          SET
            name = $1,
            description = $2,
            price = $3,
            image_url = $4,
            category_id = $5,
            stock = $6
          WHERE id = $7
            AND seller_id = $8
          RETURNING *
          `,
          [
            name.trim(),
            description?.trim() || null,
            numericPrice,
            image_url || null,
            category_id || null,
            numericStock,
            id,
            req.user.id,
          ]
        );
      }

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Product not found or you do not own this product",
        });
      }

      res.json({
        success: true,
        message: "Product updated successfully",
        product: result.rows[0],
      });
    } catch (error) {
      console.error("Update seller product error:", error);

      res.status(500).json({
        success: false,
        message: error.message || "Failed to update product",
      });
    }
  }
);

// =====================================================
// DELETE SELLER PRODUCT
// =====================================================
router.delete(
  "/products/:id",
  protect,
  authorize("seller", "admin"),
  async (req, res) => {
    try {
      const { id } = req.params;

      let result;

      if (req.user.role === "admin") {
        result = await pool.query(
          `
          DELETE FROM products
          WHERE id = $1
          RETURNING *
          `,
          [id]
        );
      } else {
        result = await pool.query(
          `
          DELETE FROM products
          WHERE id = $1
            AND seller_id = $2
          RETURNING *
          `,
          [id, req.user.id]
        );
      }

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Product not found or you do not own this product",
        });
      }

      res.json({
        success: true,
        message: "Product deleted successfully",
        product: result.rows[0],
      });
    } catch (error) {
      console.error("Delete seller product error:", error);

      res.status(500).json({
        success: false,
        message: error.message || "Failed to delete product",
      });
    }
  }
);

// =====================================================
// SELLER DASHBOARD STATS
// =====================================================
router.get(
  "/stats",
  protect,
  authorize("seller", "admin"),
  async (req, res) => {
    try {
      const sellerId = req.user.id;

      const productsResult = await pool.query(
        `
        SELECT COUNT(*)::INTEGER AS product_count
        FROM products
        WHERE seller_id = $1
        `,
        [sellerId]
      );

      const ordersResult = await pool.query(
        `
        SELECT
          COUNT(DISTINCT orders.id)::INTEGER AS order_count,
          COALESCE(
            SUM(order_items.price * order_items.quantity),
            0
          ) AS total_sales
        FROM orders
        JOIN order_items
          ON orders.id = order_items.order_id
        JOIN products
          ON order_items.product_id = products.id
        WHERE products.seller_id = $1
        `,
        [sellerId]
      );

      res.json({
        success: true,
        stats: {
          products: productsResult.rows[0].product_count,
          orders: ordersResult.rows[0].order_count,
          sales: Number(ordersResult.rows[0].total_sales),
        },
      });
    } catch (error) {
      console.error("Seller stats error:", error);

      res.status(500).json({
        success: false,
        message: "Failed to fetch seller statistics",
      });
    }
  }
);

// =====================================================
// SELLER ORDERS
// =====================================================
router.get(
  "/orders",
  protect,
  authorize("seller", "admin"),
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT
          orders.id AS order_id,
          orders.status,
          orders.created_at,
          orders.user_id AS buyer_id,

          users.name AS buyer_name,
          users.email AS buyer_email,

          products.id AS product_id,
          products.name AS product_name,

          order_items.quantity,
          order_items.price,

          (order_items.quantity * order_items.price) AS item_total

        FROM orders

        JOIN order_items
          ON orders.id = order_items.order_id

        JOIN products
          ON order_items.product_id = products.id

        JOIN users
          ON orders.user_id = users.id

        WHERE products.seller_id = $1

        ORDER BY orders.created_at DESC
        `,
        [req.user.id]
      );

      res.json({
        success: true,
        orders: result.rows,
      });
    } catch (error) {
      console.error("Seller orders error:", error);

      res.status(500).json({
        success: false,
        message: "Failed to fetch seller orders",
      });
    }
  }
);

module.exports = router;
