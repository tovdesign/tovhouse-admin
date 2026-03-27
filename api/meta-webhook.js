// Meta (Instagram/Facebook) lead webhook
// Called by Make.com or direct integration

const AIRTABLE_URL = () =>
  `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}`;

async function saveToAirtable(data) {
  const res = await fetch(AIRTABLE_URL(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      records: [
        {
          fields: {
            Name: data.name || "",
            phone: data.phone || "",
            email: data.email || "",
            interiorType: data.interiorType || "",
            budget: data.budget || "",
            area: data.area || "",
            address: data.address || "",
            schedule: data.schedule || "",
            message: data.message || "",
            status: "대기",
            platform: data.platform || "ig",
            createdAt: new Date().toLocaleString("ko-KR", {
              timeZone: "Asia/Seoul",
            }),
          },
        },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Airtable ${res.status}: ${text}`);
  }
  return res.json();
}

async function sendTelegram(data) {
  const platform = (data.platform || "ig").toLowerCase();
  const srcLabel = platform === "fb" ? "Meta (Facebook)" : "Meta (Instagram)";
  const text =
    `🔵 *${srcLabel} 새 상담 접수*\n\n` +
    `👤 ${data.name || "-"}\n` +
    `📞 ${data.phone || "-"}\n` +
    `✉️ ${data.email || "-"}\n` +
    `🏠 ${data.interiorType || "-"}\n` +
    `💰 ${data.budget || "-"}\n` +
    `📐 ${data.area || "-"}\n` +
    `📍 ${data.address || "-"}\n` +
    `🗓 ${data.schedule || "-"}\n` +
    `💬 ${(data.message || "").substring(0, 200)}\n` +
    `🕐 ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}\n\n` +
    `[접수 관리 →](https://admin.tovdesign.net/#leads)`;

  await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    },
  );
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST only" });

  try {
    const data = req.body || {};

    // Validate minimum fields
    if (!data.name && !data.phone) {
      return res.status(400).json({ error: "name 또는 phone 필요" });
    }

    // Default platform to ig if not specified
    if (!data.platform) data.platform = "ig";

    // Save to Airtable
    await saveToAirtable(data);

    // Send Telegram notification
    await sendTelegram(data).catch((err) =>
      console.error("Telegram failed:", err),
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("Meta webhook error:", err);
    return res.status(500).json({ error: err.message });
  }
};
