
const express = require("express");
const pool = require("../db");
const { protect, authorize } = require("../middleware/auth");

const router = express.Router();

const ALLOWED_CURRENCIES = ["USD", "NGN", "EUR", "GBP"];

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
        SELECT COUNT(*)::int AS count
        FROM products
        WHERE seller_id = $1
        `,
        [sellerId]
      );

      const ordersResult = await pool.query(
        `
        SELECT COUNT(DISTINCT orders.id)::int AS count
        FROM orders
        JOIN order_items
          ON orders.id = order_items.order_id
        JOIN products
          ON order_items.product_id = products.id
        WHERE products.seller_id = $1
        `,
        [sellerId]
      );

      const salesResult = await pool.query(
        `
        SELECT COALESCE(
          SUM(order_items.quantity * order_items.price),
          0
        ) AS total
        FROM order_items
        JOIN orders
          ON order_items.order_id = orders.id
        JOIN products
          ON order_items.product_id = products.id
        WHERE products.seller_id = $1
          AND orders.status != 'cancelled'
        `,
        [sellerId]
      );

      res.json({
        success: true,
        stats: {
          products: productsResult.rows[0].count,
          orders: ordersResult.rows[0].count,
          sales: salesResult.rows[0].total,
        },
      });
    } catch (error) {
      console.error("Get seller stats error:", error);

      res.status(500).json({
        success: false,
        message: "Failed to fetch seller statistics",
      });
    }
  }
);

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
          message:
            "Product not found or you do not own this product",
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

      if (
        !Number.isFinite(numericPrice) ||
        numericPrice < 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid product price",
        });
      }

      if (
        !ALLOWED_CURRENCIES.includes(productCurrency)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid currency. Use USD, NGN, EUR or GBP.",
        });
      }

      if (
        !Number.isInteger(numericStock) ||
        numericStock < 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Stock must be a non-negative whole number",
        });
      }

      const result = await pool.query(
        `
        INSERT INTO products
        (
          name,
          description,
          price,
          currency,
          image_url,
          category_id,
          stock,
          seller_id
        )
        VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
        `,
        [
          name.trim(),
          description?.trim() || null,
          numericPrice,
          productCurrency,
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
      console.error(
        "Create seller product error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          error.message || "Failed to create product",
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
        currency = "USD",
        image_url,
        category_id,
        stock,
      } = req.body;

      if (
        !name ||
        price === undefined ||
        stock === undefined
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Product name, price and stock are required",
        });
      }

      const numericPrice = Number(price);
      const numericStock = Number(stock);
      const productCurrency = String(currency).toUpperCase();

      if (
        !Number.isFinite(numericPrice) ||
        numericPrice < 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid product price",
        });
      }

      if (
        !ALLOWED_CURRENCIES.includes(productCurrency)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid currency. Use USD, NGN, EUR or GBP.",
        });
      }

      if (
        !Number.isInteger(numericStock) ||
        numericStock < 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Stock must be a non-negative whole number",
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
            currency = $4,
            image_url = $5,
            category_id = $6,
            stock = $7
          WHERE id = $8
          RETURNING *
          `,
          [
            name.trim(),
            description?.trim() || null,
            numericPrice,
            productCurrency,
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
            currency = $4,
            image_url = $5,
            category_id = $6,
            stock = $7
          WHERE id = $8
            AND seller_id = $9
          RETURNING *
          `,
          [
            name.trim(),
            description?.trim() || null,
            numericPrice,
            productCurrency,
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
          message:
            "Product not found or you do not own this product",
        });
      }

      res.json({
        success: true,
        message: "Product updated successfully",
        product: result.rows[0],
      });
    } catch (error) {
      console.error(
        "Update seller product error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          error.message || "Failed to update product",
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
          message:
            "Product not found or you do not own this product",
        });
      }

      res.json({
        success: true,
        message: "Product deleted successfully",
        product: result.rows[0],
      });
    } catch (error) {
      console.error(
        "Delete seller product error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          error.message || "Failed to delete product",
      });
    }
  }
);

// =====================================================
// SELLER PAYMENT PROTECTION — READ ONLY
//
// GET /api/seller/payment-protection?page=1
// =====================================================
//
// Allocations represent recorded order portions.
// They are NOT money held in escrow.
// They are NOT withdrawable seller balances.
//
// This endpoint cannot approve or transfer funds.
// =====================================================

router.get(
  "/payment-protection",
  protect,
  authorize("seller", "admin"),
  async (req, res) => {
    const sellerId = Number(req.user?.id);

    if (
      !Number.isSafeInteger(sellerId) ||
      sellerId <= 0
    ) {
      return res.status(401).json({
        success: false,
        message: "Valid seller login required",
      });
    }

    const requestedPage = Number(
      req.query.page ?? 1
    );

    const page =
      Number.isSafeInteger(requestedPage) &&
      requestedPage > 0
        ? Math.min(requestedPage, 100000)
        : 1;

    const limit = 20;
    const offset = (page - 1) * limit;

    try {
      const [
        allocationsResult,
        summaryResult,
        countResult,
      ] = await Promise.all([
        pool.query(
          `
          SELECT
            a.id,
            a.order_id,
            a.payment_id,
            a.seller_id,
            a.currency,
            a.gross_minor::text AS gross_minor,
            a.status,
            a.created_at,
            a.updated_at,
            o.status AS order_status,
            p.status AS payment_status,
            p.reference AS payment_reference
          FROM seller_order_allocations a
          JOIN orders o
            ON o.id = a.order_id
          JOIN payments p
            ON p.id = a.payment_id
          WHERE a.seller_id = $1
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT $2 OFFSET $3
          `,
          [sellerId, limit, offset]
        ),

        pool.query(
          `
          SELECT
            currency,
            status,
            COUNT(*)::int AS count,
            COALESCE(SUM(gross_minor), 0)::text
              AS gross_minor
          FROM seller_order_allocations
          WHERE seller_id = $1
          GROUP BY currency, status
          ORDER BY currency, status
          `,
          [sellerId]
        ),

        pool.query(
          `
          SELECT COUNT(*)::int AS total
          FROM seller_order_allocations
          WHERE seller_id = $1
          `,
          [sellerId]
        ),
      ]);

      const total =
        countResult.rows[0]?.total || 0;

      const totalPages =
        Math.ceil(total / limit);

      return res.json({
        success: true,

        message:
          "Recorded seller allocations are for review only. Withdrawals are not enabled.",

        allocations:
          allocationsResult.rows,

        summary:
          summaryResult.rows,

        page,
        limit,
        total,

        total_pages: totalPages,

        pagination: {
          page,
          limit,
          total,
          total_pages: totalPages,
          totalPages,
          has_next: page < totalPages,
          has_previous: page > 1,
        },
      });
    } catch (error) {
      console.error(
        "Seller payment protection error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Unable to load payment protection. Please try again.",
      });
    }
  }
);

module.exports = router;
