const { google } = require("googleapis");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Notify-Key");
    return res.status(204).end();
  }
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST only" });

  // Simple key check (not full auth, just prevent random calls)
  const key = req.headers["x-notify-key"];
  if (key !== process.env.INTERNAL_NOTIFY_KEY) {
    return res.status(403).json({ error: "forbidden" });
  }

  try {
    const data = req.body || {};
    await sendInternalEmail(data);
    return res.json({ success: true });
  } catch (err) {
    console.error("Internal notify error:", err);
    return res.status(500).json({ error: err.message });
  }
};

async function sendInternalEmail(data) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID || process.env.GMAIL_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET || process.env.GMAIL_CLIENT_SECRET,
  );
  oauth2.setCredentials({
    refresh_token:
      process.env.GOOGLE_REFRESH_TOKEN || process.env.GMAIL_REFRESH_TOKEN,
  });
  const gmail = google.gmail({ version: "v1", auth: oauth2 });

  const ts = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  const rid = "#M-" + Date.now().toString(36).toUpperCase();
  const p = (data.platform || "ig").toLowerCase();
  const srcLabel =
    p === "fb" ? "Facebook" : p === "web" ? "홈페이지" : "Instagram";

  function row(label, val) {
    return (
      '<tr><td style="padding:5px 0;color:#999;font-size:10px;width:60px;vertical-align:top">' +
      label +
      '</td><td style="padding:5px 0;font-size:11px">' +
      (val || "-") +
      "</td></tr>"
    );
  }
  const sep =
    '<tr><td colspan="2" style="border-top:1px solid #f0efed"></td></tr>';

  const html =
    '<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"></head>' +
    '<body style="margin:0;padding:0;background:#e8e8e6;font-family:-apple-system,sans-serif">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:#e8e8e6;padding:16px"><tr><td align="center">' +
    '<table cellpadding="0" cellspacing="0" style="background:#fff;max-width:460px;width:100%">' +
    '<tr><td style="background:linear-gradient(135deg,#12396b,#1d55a0);padding:12px 16px">' +
    '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td style="font-size:10px;font-weight:700;color:#fff;letter-spacing:2px">TOV ADMIN</td>' +
    '<td style="text-align:right;font-size:9px;color:rgba(255,255,255,0.5)">' +
    rid +
    "</td>" +
    "</tr></table></td></tr>" +
    '<tr><td style="padding:14px 16px 10px">' +
    '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td><p style="margin:0;font-size:14px;font-weight:700;color:#1a1a1a">새 상담 접수</p><p style="margin:4px 0 0;font-size:10px;color:#999">' +
    srcLabel +
    " · " +
    ts +
    "</p></td>" +
    '<td style="text-align:right"><span style="font-size:10px;font-weight:700;background:#eff6ff;color:#3b82f6;padding:4px 10px;border-radius:3px">META</span></td>' +
    "</tr></table></td></tr>" +
    '<tr><td style="padding:0 16px"><div style="border-top:1px solid #e8e8e6"></div></td></tr>' +
    '<tr><td style="padding:10px 16px">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="color:#1a1a1a">' +
    row("이름", "<b>" + (data.name || "-") + "</b>") +
    row("연락처", data.phone || "-") +
    sep +
    row("종류", data.interiorType || "-") +
    row("예산", data.budget || "-") +
    sep +
    row("지역", data.address || "-") +
    row("시기", data.schedule || "-") +
    row("플랫폼", srcLabel) +
    "</table></td></tr>" +
    '<tr><td style="background:#f5f5f3;padding:10px 16px;text-align:center">' +
    '<p style="margin:0;font-size:9px;color:#ccc">TOV HOUSE 내부 알림 · <a href="https://admin.tovdesign.net/#leads" style="color:#1d55a0;text-decoration:none">접수 관리 바로가기</a></p>' +
    "</td></tr></table></td></tr></table></body></html>";

  const RECIPIENTS = [
    "2001p@naver.com",
    "d13650@naver.com",
    "mkt@polarad.co.kr",
  ];
  const subjectB64 = Buffer.from(
    "[TOV] Meta 접수 - " + (data.name || "신규"),
  ).toString("base64");

  for (const to of RECIPIENTS) {
    const raw = Buffer.from(
      "From: TOV HOUSE <drdo6890ys@gmail.com>\r\n" +
        "To: " +
        to +
        "\r\n" +
        "Subject: =?UTF-8?B?" +
        subjectB64 +
        "?=\r\n" +
        "Content-Type: text/html; charset=utf-8\r\n\r\n" +
        html,
    ).toString("base64url");
    await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
    console.log("Internal email sent to", to);
  }
}
