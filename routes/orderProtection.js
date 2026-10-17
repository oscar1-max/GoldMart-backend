
const window = await getDeliveryWindow(client, orderId, userId);

if (requestType === "return_refund" && window?.refund_window_expired) {
  await client.query("ROLLBACK");
  inTransaction = false;

  return res.status(409).json({
    success: false,
    code: "STANDARD_REFUND_WINDOW_CLOSED",
    message:
      "The ordinary 48-hour refund window after confirmed delivery has closed. " +
      "For faulty, missing, or misdescribed goods, or other legally protected issues, " +
      "contact GoldMart support for review.",
    delivery_confirmed_at: window.confirmed_at,
    standard_refund_deadline: window.refund_deadline,
  });
}
