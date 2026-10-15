
const RESEND_API_URL = "https://api.resend.com/emails";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildHtml(message) {
  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body style="margin:0;padding:24px;background:#f7f7f7;font-family:Arial,sans-serif;color:#222;">
        <div style="max-width:560px;margin:auto;background:white;border:1px solid #eee;border-radius:12px;padding:24px;">
          <h2 style="color:#997000;margin-top:0;">GoldMart</h2>
          <p style="white-space:pre-line;line-height:1.7;">${escapeHtml(message)}</p>
          <hr style="border:0;border-top:1px solid #eee;margin:24px 0;" />
          <p style="font-size:12px;color:#777;">
            This is an automated notification from GoldMart.
            Never share your password or payment verification codes.
          </p>
        </div>
      </body>
    </html>
  `;
}

async function sendGoldMartEmail({
  to,
  subject,
  message,
}) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.GOLDMART_EMAIL_FROM;

  if (!apiKey || !from) {
    return {
      sent: false,
      reason: "Email service is not configured",
    };
  }

  if (
    typeof to !== "string" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)
  ) {
    return {
      sent: false,
      reason: "Invalid recipient email",
    };
  }

  if (
    !subject ||
    !message ||
    typeof subject !== "string" ||
    typeof message !== "string"
  ) {
    return {
      sent: false,
      reason: "Missing email content",
    };
  }

  try {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text: message,
        html: buildHtml(message),
      }),
      signal: AbortSignal.timeout(15000),
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(
        "GoldMart email provider error:",
        response.status,
        result.message || "Request failed"
      );

      return {
        sent: false,
        reason: "Email provider rejected the request",
      };
    }

    return {
      sent: true,
      emailId: result.id || null,
    };
  } catch (error) {
    console.error(
      "GoldMart email delivery error:",
      error.message
    );

    return {
      sent: false,
      reason: "Email delivery request failed",
    };
  }
}

module.exports = {
  sendGoldMartEmail,
};
