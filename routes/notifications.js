const express = require("express");

const pool = require("../db");

const router = express.Router();

// =====================================================
// GET NOTIFICATIONS FOR A USER
// GET /api/notifications/:userId
// =====================================================

router.get("/:userId", async (req, res) => {
  try {
    const userId = Number(req.params.userId);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID.",
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
      message: "Failed to load notifications.",
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
      const userId = Number(
        req.params.userId
      );

      if (
        !Number.isInteger(userId) ||
        userId <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid user ID.",
        });
      }

      const result = await pool.query(
        `
        SELECT COUNT(*)::INTEGER AS count
        FROM notifications
        WHERE user_id = $1
        AND is_read = FALSE
        `,
        [userId]
      );

      return res.json({
        success: true,
        count: result.rows[0].count,
      });
    } catch (error) {
      console.error(
        "Unread notification count error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to load unread notification count.",
      });
    }
  }
);
// =====================================================
// MARK NOTIFICATION AS READ
// PATCH /api/notifications/:userId/:notificationId/read
// =====================================================

router.patch(
  "/:userId/:notificationId/read",
  async (req, res) => {
    try {
      const userId = Number(
        req.params.userId
      );

      const notificationId = Number(
        req.params.notificationId
      );

      if (
        !Number.isInteger(userId) ||
        userId <= 0 ||
        !Number.isInteger(notificationId) ||
        notificationId <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid notification information.",
        });
      }

      const result = await pool.query(
        `
        UPDATE notifications
        SET is_read = TRUE
        WHERE id = $1
        AND user_id = $2
        RETURNING
          id,
          user_id,
          title,
          message,
          type,
          is_read,
          created_at
        `,
        [
          notificationId,
          userId,
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Notification not found.",
        });
      }

      return res.json({
        success: true,
        message: "Notification marked as read.",
        notification:
          result.rows[0],
      });
    } catch (error) {
      console.error(
        "Mark notification as read error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to update notification.",
      });
    }
  }
);

// =====================================================
// MARK ALL NOTIFICATIONS AS READ
// PATCH /api/notifications/:userId/read-all
// =====================================================

router.patch(
  "/:userId/read-all",
  async (req, res) => {
    try {
      const userId = Number(
        req.params.userId
      );

      if (
        !Number.isInteger(userId) ||
        userId <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid user ID.",
        });
      }

      const result = await pool.query(
        `
        UPDATE notifications
        SET is_read = TRUE
        WHERE user_id = $1
        AND is_read = FALSE
        `,
        [userId]
      );

      return res.json({
        success: true,
        message:
          "All notifications marked as read.",
        updated:
          result.rowCount,
      });
    } catch (error) {
      console.error(
        "Mark all notifications as read error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to update notifications.",
      });
    }
  }
);

// =====================================================
// CREATE NOTIFICATION
// POST /api/notifications
// =====================================================

router.post("/", async (req, res) => {
  try {
    const {
      user_id,
      title,
      message,
      type,
    } = req.body;

    const userId = Number(user_id);

    if (
      !Number.isInteger(userId) ||
      userId <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Valid user_id is required.",
      });
    }

    if (
      !title ||
      typeof title !== "string"
    ) {
      return res.status(400).json({
        success: false,
        message: "Notification title is required.",
      });
    }

    if (
      !message ||
      typeof message !== "string"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Notification message is required.",
      });
    }

    const result = await pool.query(
      `
      INSERT INTO notifications
        (
          user_id,
          title,
          message,
          type,
          is_read
        )
      VALUES
        ($1, $2, $3, $4, FALSE)
      RETURNING
        id,
        user_id,
        title,
        message,
        type,
        is_read,
        created_at
      `,
      [
        userId,
        title.trim(),
        message.trim(),
        type || "general",
      ]
    );

    return res.status(201).json({
      success: true,
      message:
        "Notification created successfully.",
      notification:
        result.rows[0],
    });
  } catch (error) {
    console.error(
      "Create notification error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to create notification.",
    });
  }
});

// =====================================================
// EXPORT ROUTER
// =====================================================

module.exports = router;
