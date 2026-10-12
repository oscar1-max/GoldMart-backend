
const express = require("express");
const pool = require("../db");
const { protect } = require("../middleware/auth");

const router = express.Router();

// =====================================================
// HELPERS
// =====================================================

function validId(value) {
  const id = Number(value);

  return Number.isSafeInteger(id) && id > 0
    ? id
    : null;
}

function getCurrentUserId(req) {
  return validId(req.user?.id ?? req.user?.userId);
}

function unauthorized(res) {
  return res.status(401).json({
    success: false,
    message: "Authentication required",
  });
}

// =====================================================
// GET LOGGED-IN USER'S NOTIFICATIONS
// =====================================================

async function getNotifications(userId, res) {
  const result = await pool.query(
    `
    SELECT
      n.id,
      n.user_id,
      n.title,
      n.message,
      n.type,
      n.is_read,
      n.created_at,

      CASE
        WHEN c.buyer_id = $1
          OR c.seller_id = $1
        THEN n.conversation_id
        ELSE NULL
      END AS conversation_id

    FROM notifications n

    LEFT JOIN conversations c
      ON c.id = n.conversation_id

    WHERE n.user_id = $1

    ORDER BY n.created_at DESC, n.id DESC
    `,
    [userId]
  );

  return res.json({
    success: true,
    notifications: result.rows,
  });
}

router.get("/", protect, async (req, res) => {
  try {
    const userId = getCurrentUserId(req);

    if (!userId) return unauthorized(res);

    return await getNotifications(userId, res);
  } catch (error) {
    console.error("Get notifications error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load notifications",
    });
  }
});

// =====================================================
// UNREAD NOTIFICATION COUNT
// =====================================================

async function getUnreadCount(userId, res) {
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
    count: Number(result.rows[0]?.count || 0),
  });
}

// IMPORTANT: Keep this route before GET /:userId.
router.get("/unread-count", protect, async (req, res) => {
  try {
    const userId = getCurrentUserId(req);

    if (!userId) return unauthorized(res);

    return await getUnreadCount(userId, res);
  } catch (error) {
    console.error("Unread count error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to get unread notification count",
    });
  }
});

// =====================================================
// OLD GET NOTIFICATIONS URL
// GET /api/notifications/:userId
// =====================================================

router.get("/:userId", protect, async (req, res) => {
  try {
    const currentUserId = getCurrentUserId(req);
    const requestedUserId = validId(req.params.userId);

    if (!currentUserId) return unauthorized(res);

    if (!requestedUserId) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID",
      });
    }

    if (currentUserId !== requestedUserId) {
      return res.status(403).json({
        success: false,
        message: "You can only access your own notifications",
      });
    }

    return await getNotifications(currentUserId, res);
  } catch (error) {
    console.error("Old notifications route error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load notifications",
    });
  }
});

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
      const requestedUserId = validId(req.params.userId);

      if (!currentUserId) return unauthorized(res);

      if (!requestedUserId) {
        return res.status(400).json({
          success: false,
          message: "Invalid user ID",
        });
      }

      if (currentUserId !== requestedUserId) {
        return res.status(403).json({
          success: false,
          message: "Access denied",
        });
      }

      return await getUnreadCount(currentUserId, res);
    } catch (error) {
      console.error("Old unread count error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to get unread notification count",
      });
    }
  }
);

// =====================================================
// MARK ONE NOTIFICATION AS READ
// =====================================================

router.patch(
  "/:notificationId/read",
  protect,
  async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const notificationId = validId(
        req.params.notificationId
      );

      if (!userId) return unauthorized(res);

      if (!notificationId) {
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

      if (!result.rows.length) {
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
      console.error("Mark read error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to mark notification as read",
      });
    }
  }
);

// =====================================================
// MARK ONE NOTIFICATION AS UNREAD
// =====================================================

router.patch(
  "/:notificationId/unread",
  protect,
  async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const notificationId = validId(
        req.params.notificationId
      );

      if (!userId) return unauthorized(res);

      if (!notificationId) {
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

      if (!result.rows.length) {
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
      console.error("Mark unread error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to mark notification as unread",
      });
    }
  }
);

// =====================================================
// MARK ALL NOTIFICATIONS AS READ
// =====================================================

async function markAllRead(userId, res) {
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
}

router.patch("/read-all", protect, async (req, res) => {
  try {
    const userId = getCurrentUserId(req);

    if (!userId) return unauthorized(res);

    return await markAllRead(userId, res);
  } catch (error) {
    console.error("Mark all read error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to mark all notifications as read",
    });
  }
});

// =====================================================
// OLD MARK ALL AS READ URL
// =====================================================

router.patch(
  "/:userId/read-all",
  protect,
  async (req, res) => {
    try {
      const currentUserId = getCurrentUserId(req);
      const requestedUserId = validId(req.params.userId);

      if (!currentUserId) return unauthorized(res);

      if (!requestedUserId) {
        return res.status(400).json({
          success: false,
          message: "Invalid user ID",
        });
      }

      if (requestedUserId !== currentUserId) {
        return res.status(403).json({
          success: false,
          message: "Access denied",
        });
      }

      return await markAllRead(currentUserId, res);
    } catch (error) {
      console.error("Old mark all read error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to mark all notifications as read",
      });
    }
  }
);

// =====================================================
// DELETE ONE NOTIFICATION
// =====================================================

router.delete(
  "/:notificationId",
  protect,
  async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const notificationId = validId(
        req.params.notificationId
      );

      if (!userId) return unauthorized(res);

      if (!notificationId) {
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

      if (!result.rows.length) {
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
      console.error("Delete notification error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to delete notification",
      });
    }
  }
);

module.exports = router;
