const express = require("express");
const pool = require("../db");
const { protect } = require("../middleware/auth");

const router = express.Router();

// =====================================================
// HELPER
// =====================================================

function getCurrentUserId(req) {
  if (req.user && req.user.id) {
    return Number(req.user.id);
  }

  if (req.user && req.user.userId) {
    return Number(req.user.userId);
  }

  return null;
}

// =====================================================
// GET CURRENT USER NOTIFICATIONS
// GET /api/notifications
// =====================================================

router.get("/", protect, async (req, res) => {
  try {
    const userId = getCurrentUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
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
    console.error("Get notifications error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load notifications",
    });
  }
});

// =====================================================
// BACKWARD-COMPATIBLE GET USER NOTIFICATIONS
// GET /api/notifications/:userId
//
// Still supports the old frontend URL, but only allows
// the currently authenticated user to access their own.
// =====================================================

router.get("/:userId", protect, async (req, res) => {
  try {
    const currentUserId = getCurrentUserId(req);
    const requestedUserId = Number(req.params.userId);

    if (!currentUserId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    if (
      !Number.isInteger(requestedUserId) ||
      requestedUserId <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID",
      });
    }

    if (Number(currentUserId) !== Number(requestedUserId)) {
      return res.status(403).json({
        success: false,
        message: "You can only access your own notifications",
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
      [requestedUserId]
    );

    return res.json({
      success: true,
      notifications: result.rows,
    });
  } catch (error) {
    console.error("Get notifications error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load notifications",
    });
  }
});

// =====================================================
// GET UNREAD NOTIFICATION COUNT
// GET /api/notifications/unread-count
// =====================================================

router.get(
  "/unread-count",
  protect,
  async (req, res) => {
    try {
      const userId = getCurrentUserId(req);

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
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
// OLD UNREAD COUNT URL
// GET /api/notifications/:userId/unread-count
// =====================================================

router.get(
  "/:userId/unread-count",
  protect,
  async (req, res) => {
    try {
      const currentUserId = getCurrentUserId(req);
      const requestedUserId = Number(req.params.userId);

      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      if (
        !Number.isInteger(requestedUserId) ||
        requestedUserId <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid user ID",
        });
      }

      if (
        Number(currentUserId) !==
        Number(requestedUserId)
      ) {
        return res.status(403).json({
          success: false,
          message: "Access denied",
        });
      }

      const result = await pool.query(
        `
        SELECT COUNT(*) AS count
        FROM notifications
        WHERE user_id = $1
        AND is_read = FALSE
        `,
        [requestedUserId]
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
  protect,
  async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const notificationId = Number(
        req.params.notificationId
      );

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

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
        AND user_id = $2
        RETURNING *
        `,
        [notificationId, userId]
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
// MARK ONE NOTIFICATION AS UNREAD
// PATCH /api/notifications/:notificationId/unread
// =====================================================

router.patch(
  "/:notificationId/unread",
  protect,
  async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const notificationId = Number(
        req.params.notificationId
      );

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

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
        SET is_read = FALSE
        WHERE id = $1
        AND user_id = $2
        RETURNING *
        `,
        [notificationId, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Notification not found",
        });
      }

      return res.json({
        success: true,
        message: "Notification marked as unread",
        notification: result.rows[0],
      });
    } catch (error) {
      console.error(
        "Mark notification unread error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to mark notification as unread",
      });
    }
  }
);

// =====================================================
// MARK ALL NOTIFICATIONS AS READ
// PATCH /api/notifications/read-all
// =====================================================

router.patch(
  "/read-all",
  protect,
  async (req, res) => {
    try {
      const userId = getCurrentUserId(req);

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
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
        message: "All notifications marked as read",
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

// =====================================================
// OLD MARK-ALL URL
// PATCH /api/notifications/:userId/read-all
// =====================================================

router.patch(
  "/:userId/read-all",
  protect,
  async (req, res) => {
    try {
      const currentUserId = getCurrentUserId(req);
      const requestedUserId = Number(req.params.userId);

      if (!currentUserId) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      if (
        !Number.isInteger(requestedUserId) ||
        requestedUserId <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid user ID",
        });
      }

      if (
        Number(currentUserId) !==
        Number(requestedUserId)
      ) {
        return res.status(403).json({
          success: false,
          message: "Access denied",
        });
      }

      await pool.query(
        `
        UPDATE notifications
        SET is_read = TRUE
        WHERE user_id = $1
        `,
        [requestedUserId]
      );

      return res.json({
        success: true,
        message: "All notifications marked as read",
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

// =====================================================
// DELETE ONE NOTIFICATION
// DELETE /api/notifications/:notificationId
// =====================================================

router.delete(
  "/:notificationId",
  protect,
  async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const notificationId = Number(
        req.params.notificationId
      );

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

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
        DELETE FROM notifications
        WHERE id = $1
        AND user_id = $2
        RETURNING id
        `,
        [notificationId, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Notification not found",
        });
      }

      return res.json({
        success: true,
        message: "Notification deleted",
      });
    } catch (error) {
      console.error(
        "Delete notification error:",
        error
      );

      return res.status(500).json({
        success: false,
        message: "Failed to delete notification",
      });
    }
  }
);

module.exports = router;
