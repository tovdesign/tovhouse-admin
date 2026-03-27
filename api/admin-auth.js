// In-memory OTP store: code -> { ts, used }
const otpStore = new Map();
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function cleanExpired() {
  const now = Date.now();
  for (const [code, val] of otpStore) {
    if (now - val.ts > OTP_TTL_MS) otpStore.delete(code);
  }
}

async function sendOtpViaTelegram(code) {
  const https = require("https");
  const text = `🔐 토브하우스 관리자 로그인 코드\n\n인증번호: *${code}*\n\n5분 내에 입력해주세요.`;
  const postData = JSON.stringify({
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: "Markdown",
  });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode < 300) resolve();
          else reject(new Error(`Telegram error ${res.statusCode}: ${body}`));
        });
      },
    );
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  cleanExpired();

  const { action } = body || {};

  if (action === "send-code") {
    const code = generateCode();
    otpStore.set(code, { ts: Date.now(), used: false });
    try {
      await sendOtpViaTelegram(code);
    } catch (err) {
      console.error("OTP Telegram send failed:", err);
      return res.status(500).json({ error: "인증번호 전송에 실패했습니다." });
    }
    return res.status(200).json({ success: true });
  }

  if (action === "verify") {
    const { code } = body;
    if (!code) {
      return res.status(400).json({ error: "인증번호를 입력해주세요." });
    }
    const entry = otpStore.get(String(code));
    if (!entry) {
      return res.status(401).json({ error: "인증번호가 올바르지 않습니다." });
    }
    if (Date.now() - entry.ts > OTP_TTL_MS) {
      otpStore.delete(String(code));
      return res.status(401).json({ error: "인증번호가 만료되었습니다." });
    }
    if (entry.used) {
      return res.status(401).json({ error: "이미 사용된 인증번호입니다." });
    }
    entry.used = true;
    const token = Buffer.from(
      JSON.stringify({ code, ts: Date.now() }),
    ).toString("base64");
    return res.status(200).json({ success: true, token });
  }

  return res.status(400).json({ error: "action must be send-code or verify" });
};
