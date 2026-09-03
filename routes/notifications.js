const express = require("express");

const pool = require("../db");

const router = express.Router();

// =====================================================
// GET USER NOTIFICATIONS
// GET /api/notifications/:userId
// =====================================================

router.get("/:userId", async (req, res) => {
  try {
    const userId = Number(req.params.userId);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID",
      });
    }

    const result = await pool.query(
      `
      SELECT
        id,
        user_id,
        title,
        message,
        type,
        is_read,
        created_at
      FROM notifications
      WHERE user_id = $1
      ORDER BY created_at DESC
      `,
      [userId]
    );

    return res.json({
      success: true,
      notifications: result.rows,
    });
  } catch (error) {
    console.error(
      "Get notifications error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to load notifications",
    });
  }
});

// =====================================================
// GET UNREAD NOTIFICATION COUNT
// GET /api/notifications/:userId/unread-count
// =====================================================

router.get(
  "/:userId/unread-count",
  async (req, res) => {
    try {
      const userId = Number(req.params.userId);

      if (
        !Number.isInteger(userId) ||
        userId <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid user ID",
        });
      }

      const result = await pool.query(
        `
        SELECT COUNT(*) AS count
        FROM notifications
        WHERE user_id = $1
        AND is_read = FALSE
        `,
        [userId]
      );

      return res.json({
        success: true,
        count: Number(result.rows[0].count),
      });
    } catch (error) {
      console.error(
        "Unread notification count error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to get unread notification count",
      });
    }
  }
);

// =====================================================
// MARK ONE NOTIFICATION AS READ
// PATCH /api/notifications/:notificationId/read
// =====================================================

router.patch(
  "/:notificationId/read",
  async (req, res) => {
    try {
      const notificationId = Number(
        req.params.notificationId
      );

      if (
        !Number.isInteger(notificationId) ||
        notificationId <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid notification ID",
        });
      }

      const result = await pool.query(
        `
        UPDATE notifications
        SET is_read = TRUE
        WHERE id = $1
        RETURNING *
        `,
        [notificationId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Notification not found",
        });
      }

      return res.json({
        success: true,
        message: "Notification marked as read",
        notification: result.rows[0],
      });
    } catch (error) {
      console.error(
        "Mark notification read error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to mark notification as read",
      });
    }
  }
);

// =====================================================
// MARK ALL USER NOTIFICATIONS AS READ
// PATCH /api/notifications/:userId/read-all
// =====================================================

router.patch(
  "/:userId/read-all",
  async (req, res) => {
    try {
      const userId = Number(req.params.userId);

      if (
        !Number.isInteger(userId) ||
        userId <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid user ID",
        });
      }

      await pool.query(
        `
        UPDATE notifications
        SET is_read = TRUE
        WHERE user_id = $1
        `,
        [userId]
      );

      return res.json({
        success: true,
        message:
          "All notifications marked as read",
      });
    } catch (error) {
      console.error(
        "Mark all notifications read error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to mark notifications as read",
      });
    }
  }
);

module.exports = router;
