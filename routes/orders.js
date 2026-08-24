const express = require("express");
const pool = require("../db");
const { protect } = require("../middleware/auth");

const router = express.Router();

const USD_TO_NGN_RATE =
  Number(process.env.USD_TO_NGN_RATE) || 1500;

// =====================================================
// NORMALIZE CURRENCY
// =====================================================

function normalizeCurrency(currency) {
  return String(currency || "USD").toUpperCase();
}

// =====================================================
// DELIVERY FEE
// GoldMart checkout currently uses FREE delivery.
// Keep this consistent with checkout.
// =====================================================

function getDeliveryFee() {
  return 0;
}

// =====================================================
// CREATE ORDER AFTER VERIFIED PAYMENT
// =====================================================

router.post(
  "/",
  protect,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const {
        paymentReference,
        delivery = {},
      } = req.body;

      if (!paymentReference) {
        return res.status(400).json({
          success: false,
          message:
            "Payment reference is required",
        });
      }

      await client.query("BEGIN");

      // =================================================
      // FIND VERIFIED PAYMENT
      // =================================================

      const paymentResult =
        await client.query(
          `
          SELECT *
          FROM payments
          WHERE reference = $1
            AND user_id = $2
            AND status = 'success'
          FOR UPDATE
          `,
          [
            paymentReference,
            req.user.id,
          ]
        );

      if (
        paymentResult.rows.length === 0
      ) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "Verified payment not found",
        });
      }

      const payment =
        paymentResult.rows[0];

      // =================================================
      // PREVENT DUPLICATE ORDERS
      // =================================================

      if (payment.order_id) {
        const existingOrder =
          await client.query(
            `
            SELECT
              id,
              user_id,
              total_amount,
              status,
              created_at
            FROM orders
            WHERE id = $1
            `,
            [payment.order_id]
          );

        await client.query("ROLLBACK");

        return res.json({
          success: true,
          message:
            "Order already exists",
          order:
            existingOrder.rows[0],
        });
      }

      // =================================================
      // FIND USER CART
      // =================================================

      const cartResult =
        await client.query(
          `
          SELECT id
          FROM carts
          WHERE user_id = $1
          LIMIT 1
          `,
          [req.user.id]
        );

      if (
        cartResult.rows.length === 0
      ) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "Your cart is empty",
        });
      }

      const cartId =
        cartResult.rows[0].id;

      // =================================================
      // GET CART ITEMS
      // =================================================

      const cartItemsResult =
        await client.query(
          `
          SELECT
            cart_items.id,
            cart_items.product_id,
            cart_items.quantity,

            products.name,
            products.price,
            products.currency,
            products.stock,
            products.seller_id,
            products.image_url

          FROM cart_items

          INNER JOIN products
            ON cart_items.product_id =
               products.id

          WHERE cart_items.cart_id = $1

          FOR UPDATE OF products
          `,
          [cartId]
        );

      if (
        cartItemsResult.rows.length === 0
      ) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "Your cart is empty",
        });
      }

      // =================================================
      // CHECK CART CURRENCIES
      // =================================================

      const currencies =
        Array.from(
          new Set(
            cartItemsResult.rows.map(
              (item) =>
                normalizeCurrency(
                  item.currency
                )
            )
          )
        );

      if (currencies.length !== 1) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "Cart contains products with different currencies.",
        });
      }

      const orderCurrency =
        currencies[0];

      // =================================================
      // SUPPORTED GOLDMART CURRENCIES
      // =================================================

      const supportedCurrencies = [
        "USD",
        "NGN",
      ];

      if (
        !supportedCurrencies.includes(
          orderCurrency
        )
      ) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            `GoldMart currently supports USD and NGN checkout. Product currency ${orderCurrency} is not supported.`,
        });
      }

      // =================================================
      // CALCULATE ORDER TOTAL
      // =================================================

      let productsTotal = 0;

      for (
        const item of cartItemsResult.rows
      ) {
        const price =
          Number(item.price);

        const quantity =
          Number(item.quantity);

        const stock =
          Number(item.stock);

        if (
          !Number.isFinite(price) ||
          !Number.isFinite(quantity) ||
          quantity <= 0
        ) {
          await client.query("ROLLBACK");

          return res.status(400).json({
            success: false,
            message:
              "Invalid cart item",
          });
        }

        if (stock < quantity) {
          await client.query("ROLLBACK");

          return res.status(400).json({
            success: false,
            message:
              `${item.name} does not have enough stock`,
          });
        }

        productsTotal +=
          price * quantity;
      }

      // =================================================
      // DELIVERY
      // =================================================

      const deliveryFee =
        getDeliveryFee(orderCurrency);

      const calculatedTotal =
        productsTotal +
        deliveryFee;

      // =================================================
      // PAYMENT IS ALWAYS NGN IN PAYSTACK
      //
      // USD PRODUCT:
      // $100 × 1500 = ₦150,000
      //
      // NGN PRODUCT:
      // ₦10,000 = ₦10,000
      // =================================================

      const paymentAmountNGN =
        Number(payment.amount);

      let expectedPaymentAmountNGN;

      if (orderCurrency === "USD") {
        expectedPaymentAmountNGN =
          Math.round(
            calculatedTotal *
              USD_TO_NGN_RATE
          );
      } else {
        expectedPaymentAmountNGN =
          Math.round(
            calculatedTotal
          );
      }

      if (
        !Number.isFinite(
          paymentAmountNGN
        ) ||
        Math.abs(
          paymentAmountNGN -
            expectedPaymentAmountNGN
        ) > 1
      ) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message:
            "Payment amount does not match the order total.",
          details: {
            order_currency:
              orderCurrency,

            order_total:
              Number(
                calculatedTotal.toFixed(2)
              ),

            expected_payment_ngn:
              expectedPaymentAmountNGN,

            received_payment_ngn:
              paymentAmountNGN,

            exchange_rate:
              USD_TO_NGN_RATE,
          },
        });
      }

      // =================================================
      // CREATE ORDER
      // =================================================

      const orderResult =
        await client.query(
          `
          INSERT INTO orders (
            user_id,
            total_amount,
            status
          )
          VALUES (
            $1,
            $2,
            $3
          )
          RETURNING
            id,
            user_id,
            total_amount,
            status,
            created_at
          `,
          [
            req.user.id,
            calculatedTotal,
            "processing",
          ]
        );

      const order =
        orderResult.rows[0];

      // =================================================
      // CREATE ORDER ITEMS
      // =================================================

      for (
        const item of cartItemsResult.rows
      ) {
        await client.query(
          `
          INSERT INTO order_items (
            order_id,
            product_id,
            quantity,
            price
          )
          VALUES (
            $1,
            $2,
            $3,
            $4
          )
          `,
          [
            order.id,
            item.product_id,
            item.quantity,
            item.price,
          ]
        );

        // =================================================
        // REDUCE STOCK
        // =================================================

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

      // =================================================
      // CONNECT PAYMENT TO ORDER
      // =================================================

      await client.query(
        `
        UPDATE payments
        SET
          order_id = $1,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        `,
        [
          order.id,
          payment.id,
        ]
      );

      // =================================================
      // DELETE CART ITEMS
      // =================================================

      await client.query(
        `
        DELETE FROM cart_items
        WHERE cart_id = $1
        `,
        [cartId]
      );

      await client.query("COMMIT");

      // =================================================
      // SUCCESS
      // =================================================

      return res.status(201).json({
        success: true,

        message:
          "Payment confirmed and order created successfully",

        order,

        payment: {
          reference:
            payment.reference,

          amount:
            payment.amount,

          currency:
            payment.currency,

          status:
            payment.status,
        },

        delivery,

        order_currency:
          orderCurrency,

        order_total:
          calculatedTotal,

        payment_amount_ngn:
          paymentAmountNGN,

        exchange_rate:
          USD_TO_NGN_RATE,
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error(
        "Create order error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to create order",
      });
    } finally {
      client.release();
    }
  }
);

// =====================================================
// GET LOGGED-IN USER'S ORDERS
// =====================================================

router.get(
  "/",
  protect,
  async (req, res) => {
    try {
      const ordersResult =
        await pool.query(
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

      for (
        const order of ordersResult.rows
      ) {
        const itemsResult =
          await pool.query(
            `
            SELECT
              order_items.id,
              order_items.product_id,
              order_items.quantity,
              order_items.price,

              products.name,
              products.image_url,
              products.seller_id,
              products.currency

            FROM order_items

            LEFT JOIN products
              ON order_items.product_id =
                 products.id

            WHERE order_items.order_id = $1
            `,
            [order.id]
          );

        orders.push({
          ...order,
          items:
            itemsResult.rows,
        });
      }

      return res.json({
        success: true,
        orders,
      });
    } catch (error) {
      console.error(
        "Get orders error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to fetch orders",
      });
    }
  }
);

// =====================================================
// GET SELLER'S CUSTOMER ORDERS
// =====================================================

router.get(
  "/seller/all",
  protect,
  async (req, res) => {
    try {
      const sellerId =
        req.user.id;

      const ordersResult =
        await pool.query(
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
            ON orders.id =
               order_items.order_id

          INNER JOIN products
            ON order_items.product_id =
               products.id

          INNER JOIN users
            ON orders.user_id =
               users.id

          WHERE products.seller_id = $1

          ORDER BY orders.created_at DESC
          `,
          [sellerId]
        );

      const orders = [];

      for (
        const order of ordersResult.rows
      ) {
        const itemsResult =
          await pool.query(
            `
            SELECT
              order_items.id,
              order_items.product_id,

              products.name AS product_name,

              order_items.quantity,
              order_items.price,

              products.image_url,
              products.currency

            FROM order_items

            INNER JOIN products
              ON order_items.product_id =
                 products.id

            WHERE order_items.order_id = $1
              AND products.seller_id = $2

            ORDER BY order_items.id ASC
            `,
            [
              order.id,
              sellerId,
            ]
          );

        orders.push({
          ...order,
          items:
            itemsResult.rows,
        });
      }

      return res.json({
        success: true,
        orders,
      });
    } catch (error) {
      console.error(
        "Get seller orders error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to fetch seller orders",
      });
    }
  }
);

// =====================================================
// UPDATE SELLER ORDER STATUS
// =====================================================

router.put(
  "/seller/:orderId/status",
  protect,
  async (req, res) => {
    try {
      const {
        orderId,
      } = req.params;

      const {
        status,
      } = req.body;

      const sellerId =
        req.user.id;

      const allowedStatuses = [
        "pending",
        "processing",
        "shipped",
        "delivered",
        "cancelled",
      ];

      if (
        !allowedStatuses.includes(
          status
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid order status",
        });
      }

      const sellerOrderCheck =
        await pool.query(
          `
          SELECT orders.id

          FROM orders

          INNER JOIN order_items
            ON orders.id =
               order_items.order_id

          INNER JOIN products
            ON order_items.product_id =
               products.id

          WHERE orders.id = $1
            AND products.seller_id = $2

          LIMIT 1
          `,
          [
            orderId,
            sellerId,
          ]
        );

      if (
        sellerOrderCheck.rows.length ===
        0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Order not found for this seller",
        });
      }

      const updatedOrder =
        await pool.query(
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
          [
            status,
            orderId,
          ]
        );

      return res.json({
        success: true,
        message:
          "Order status updated successfully",
        order:
          updatedOrder.rows[0],
      });
    } catch (error) {
      console.error(
        "Update seller order status error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to update order status",
      });
    }
  }
);

// =====================================================
// GET ONE ORDER
// =====================================================

router.get(
  "/:orderId",
  protect,
  async (req, res) => {
    try {
      const {
        orderId,
      } = req.params;

      const orderResult =
        await pool.query(
          `
          SELECT *
          FROM orders
          WHERE id = $1
            AND user_id = $2
          `,
          [
            orderId,
            req.user.id,
          ]
        );

      if (
        orderResult.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Order not found",
        });
      }

      const itemsResult =
        await pool.query(
          `
          SELECT
            order_items.id,
            order_items.product_id,
            order_items.quantity,
            order_items.price,

            products.name,
            products.image_url,
            products.seller_id,
            products.currency

          FROM order_items

          LEFT JOIN products
            ON order_items.product_id =
               products.id

          WHERE order_items.order_id = $1
          `,
          [orderId]
        );

      return res.json({
        success: true,

        order:
          orderResult.rows[0],

        items:
          itemsResult.rows,
      });
    } catch (error) {
      console.error(
        "Get order error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to fetch order",
      });
    }
  }
);

module.exports = router;
