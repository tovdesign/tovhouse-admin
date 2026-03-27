const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { google } = require("googleapis");
const crypto = require("crypto");

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function uploadPhoto(dataUrl, key) {
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
  const buffer = Buffer.from(base64, "base64");
  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: "image/webp",
      CacheControl: "public, max-age=31536000",
    }),
  );
  return `${process.env.R2_PUBLIC_URL || "https://pub-64e468fed30d4c00aefa275f39dd9f92.r2.dev"}/${key}`;
}

const AT_BASE = () =>
  `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}`;
const AT_HEADERS = () => ({
  Authorization: `Bearer ${process.env.AIRTABLE_API_KEY || process.env.AIRTABLE_TOKEN}`,
  "Content-Type": "application/json",
});

async function checkDuplicateAndMemo(data) {
  // Search for existing records by phone
  const phone = (data.phone || "").replace(/[^0-9]/g, "");
  if (!phone) return null;
  const formula = encodeURIComponent(
    `FIND("${phone}",SUBSTITUTE({phone},"-",""))>0`,
  );
  const res = await fetch(
    `${AT_BASE()}?filterByFormula=${formula}&sort%5B0%5D%5Bfield%5D=createdAt&sort%5B0%5D%5Bdirection%5D=desc`,
    { headers: AT_HEADERS() },
  );
  if (!res.ok) return null;
  const result = await res.json();
  const records = result.records || [];
  if (records.length === 0) return null;

  // Build memo with previous submissions
  const now = new Date(Date.now() + 9 * 3600000).toISOString();
  const dates = records.map((r) => {
    const d = r.fields.createdAt || r.createdTime;
    return d
      ? new Date(d).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })
      : "날짜 불명";
  });
  const memoEntry = {
    author: "시스템",
    text: `재접수 (${records.length + 1}회차)\n이전 접수: ${dates.join(", ")}`,
    date: now,
    id: Date.now(),
  };

  // Also add memo to previous records
  for (const rec of records) {
    const existingMemo = rec.fields.memo || "";
    let threads = [];
    try {
      threads = JSON.parse(existingMemo);
    } catch (e) {}
    if (!Array.isArray(threads))
      threads = existingMemo
        ? [{ author: "관리자", text: existingMemo, date: now, id: Date.now() }]
        : [];
    const alreadyHasResubmit = threads.some(
      (t) => t.author === "시스템" && t.text && t.text.includes("재접수"),
    );
    if (!alreadyHasResubmit) {
      threads.push({
        author: "시스템",
        text: `이 고객이 ${now.split("T")[0]} 재접수함`,
        date: now,
        id: Date.now(),
      });
      await fetch(AT_BASE(), {
        method: "PATCH",
        headers: AT_HEADERS(),
        body: JSON.stringify({
          records: [{ id: rec.id, fields: { memo: JSON.stringify(threads) } }],
        }),
      });
    }
  }

  return JSON.stringify([memoEntry]);
}

async function saveToAirtable(data, photoUrls, clientIp) {
  // Check for duplicate submissions
  const dupMemo = await checkDuplicateAndMemo(data).catch(() => null);

  const res = await fetch(AT_BASE(), {
    method: "POST",
    headers: AT_HEADERS(),
    body: JSON.stringify({
      records: [
        {
          fields: {
            Name: data.name,
            phone: data.phone,
            email: data.email || "",
            interiorType: data.interiorType || "",
            budget: data.budget || "",
            area: data.area || "",
            address: data.address || "",
            schedule: data.schedule || "",
            message: data.message || "",
            status: "대기",
            source: "homepage",
            platform: "web",
            ip: clientIp || "",
            memo: dupMemo || "",
            photos: photoUrls.map((url) => ({ url })),
            createdAt: new Date(Date.now() + 9 * 3600000).toISOString(),
          },
        },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Airtable error ${res.status}: ${text}`);
  }
  return res.json();
}

async function sendTelegram(data, photoCount, platform) {
  const src = platform === "web" ? "홈페이지" : "Meta";
  const srcIcon = platform === "web" ? "🟢" : "🔵";
  const text =
    `${srcIcon} *${src} 새 상담 접수*\n\n` +
    `👤 ${data.name}\n` +
    `📞 ${data.phone}\n` +
    `✉️ ${data.email || "-"}\n` +
    `🏠 ${data.interiorType || "-"}\n` +
    `💰 ${data.budget || "-"}\n` +
    `📐 ${data.area || "-"}\n` +
    `📍 ${data.address || "-"}\n` +
    `🗓 ${data.schedule || "-"}\n` +
    `💬 ${(data.message || "").substring(0, 200)}\n` +
    (photoCount ? `📷 ${photoCount}장\n` : "") +
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

async function sendLMS(data) {
  const serviceId =
    process.env.NCP_SMS_SERVICE_ID || process.env.SENS_SERVICE_ID;
  const accessKey =
    process.env.NCP_SMS_ACCESS_KEY || process.env.SENS_ACCESS_KEY;
  const secretKey =
    process.env.NCP_SMS_SECRET_KEY || process.env.SENS_SECRET_KEY;
  const sender =
    process.env.NCP_SMS_SENDER || process.env.SENS_SENDER || "01062023618";
  console.log("LMS env check:", {
    serviceId: !!serviceId,
    accessKey: !!accessKey,
    secretKey: !!secretKey,
    sender,
  });
  if (!serviceId || !accessKey || !secretKey) {
    console.log("LMS SKIPPED: missing env vars");
    return;
  }

  const phone = data.phone.replace(/[^0-9]/g, "");
  if (!phone) return;

  const timestamp = Date.now().toString();
  const method = "POST";
  const url = `/sms/v2/services/${encodeURIComponent(serviceId)}/messages`;
  const message = `[TOV HOUSE] 상담 접수 확인\n\n${data.name}님, 상담이 정상 접수되었습니다.\n\n■ 접수 내용\n- 종류: ${data.interiorType || "-"}\n- 예산: ${data.budget || "-"}\n- 평수: ${data.area || "-"}\n- 희망시기: ${data.schedule || "-"}\n- 지역: ${data.address || "-"}\n\n담당 디자이너가 1일 이내 연락드립니다.\n\nTOV HOUSE | tovdesign.net`;

  // HMAC-SHA256 signature
  const space = " ";
  const newLine = "\n";
  const hmac = crypto.createHmac("SHA256", secretKey);
  hmac.update(method + space + url + newLine + timestamp + newLine + accessKey);
  const signature = hmac.digest("base64");

  const body = {
    type: "LMS",
    contentType: "COMM",
    countryCode: "82",
    from: sender.replace(/[^0-9]/g, ""),
    subject: "[TOV HOUSE] 상담 접수 확인",
    content: message,
    messages: [{ to: phone }],
  };

  const smsRes = await fetch(`https://sens.apigw.ntruss.com${url}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "x-ncp-apigw-timestamp": timestamp,
      "x-ncp-iam-access-key": accessKey,
      "x-ncp-apigw-signature-v2": signature,
    },
    body: JSON.stringify(body),
  });

  const smsResult = await smsRes.text();
  console.log(`LMS ${smsRes.status} to ${phone}: ${smsResult}`);

  // 텔레그램에 발송 결과 기록
  if (process.env.TELEGRAM_BOT_TOKEN) {
    const ok = smsRes.status === 202;
    const logText = ok
      ? `✅ 문자 발송 성공\n📞 ${phone}\n👤 ${data.name}`
      : `❌ 문자 발송 실패 (${smsRes.status})\n📞 ${phone}\n👤 ${data.name}\n${smsResult.substring(0, 100)}`;
    fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: logText,
          disable_web_page_preview: true,
        }),
      },
    ).catch(() => {});
  }

  if (!smsRes.ok) {
    throw new Error(`NCP SMS error ${smsRes.status}: ${smsResult}`);
  }
}

async function sendEmails(data, photoCount) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID || process.env.GMAIL_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET || process.env.GMAIL_CLIENT_SECRET,
  );
  oauth2.setCredentials({
    refresh_token:
      process.env.GOOGLE_REFRESH_TOKEN || process.env.GMAIL_REFRESH_TOKEN,
  });
  const gmail = google.gmail({ version: "v1", auth: oauth2 });

  const ts = new Date()
    .toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })
    .replace(/\. /g, ".")
    .replace(/\.$/, "");
  const rid = `#C-${Date.now().toString(36).toUpperCase()}`;

  const htmlBody = `<!DOCTYPE html>
<html lang="ko">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#e8e8e6;font-family:-apple-system,'Apple SD Gothic Neo',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#e8e8e6;padding:16px"><tr><td align="center">
<table cellpadding="0" cellspacing="0" style="background:#fff;max-width:460px;width:100%">
  <tr><td style="background:linear-gradient(135deg,#1d55a0,#5a8bc7);padding:16px 24px">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:12px;font-weight:800;color:#fff;letter-spacing:2px">TOV HOUSE</td>
      <td style="text-align:right;font-size:9px;color:rgba(255,255,255,0.5)">${rid}</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:18px 24px 14px">
    <p style="margin:0;font-size:16px;font-weight:700;color:#1a1a1a">상담 신청이 접수되었습니다</p>
    <p style="margin:6px 0 0;font-size:12px;color:#999">${data.name}님, 담당 디자이너가 1일 이내 연락드립니다.</p>
  </td></tr>
  <tr><td style="padding:0 24px"><div style="border-top:1px solid #e8e8e6"></div></td></tr>
  <tr><td style="padding:14px 24px">
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:11px;color:#1a1a1a">
      <tr>
        <td style="vertical-align:top;width:50%;padding-right:16px">
          <p style="margin:0 0 8px;font-size:9px;font-weight:700;color:#999;letter-spacing:2px">접수 정보</p>
          <p style="margin:0;line-height:1.9"><span style="color:#999">이름</span> ${data.name}<br><span style="color:#999">연락처</span> ${data.phone}<br><span style="color:#999">이메일</span> ${data.email}</p>
        </td>
        <td style="vertical-align:top;width:50%;border-left:1px solid #e8e8e6;padding-left:16px">
          <p style="margin:0 0 8px;font-size:9px;font-weight:700;color:#999;letter-spacing:2px">상담 내용</p>
          <p style="margin:0;line-height:1.9"><span style="color:#999">종류</span> ${data.interiorType || "-"}<br><span style="color:#999">예산</span> ${data.budget || "-"}<br><span style="color:#999">평수</span> ${data.area || "-"}</p>
        </td>
      </tr>
    </table>
  </td></tr>
  <tr><td style="padding:0 24px"><div style="border-top:1px solid #e8e8e6"></div></td></tr>
  <tr><td style="padding:12px 24px">
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:11px;color:#1a1a1a">
      <tr>
        <td style="padding:4px 0"><span style="color:#999;font-size:10px">시공 지역</span></td>
        <td style="padding:4px 0;text-align:right">${data.address || "-"}</td>
      </tr>
      <tr>
        <td style="padding:4px 0;border-top:1px solid #f5f5f3"><span style="color:#999;font-size:10px">희망 시기</span></td>
        <td style="padding:4px 0;text-align:right;border-top:1px solid #f5f5f3">${data.schedule ? `<span style="font-size:9px;background:#e8eef5;color:#1d55a0;padding:2px 6px">${data.schedule}</span>` : "-"}
      </tr>
    </table>
  </td></tr>
  ${
    data.message
      ? `<tr><td style="padding:0 24px"><div style="border-top:1px solid #e8e8e6"></div></td></tr>
  <tr><td style="padding:12px 24px">
    <p style="margin:0 0 6px;font-size:9px;font-weight:700;color:#999;letter-spacing:2px">요청 내용</p>
    <p style="margin:0;font-size:11px;color:#555;line-height:1.7;background:#fafaf8;padding:10px 12px;border-radius:4px">${data.message}</p>
  </td></tr>`
      : ""
  }
  <tr><td style="background:#fafaf8;padding:14px 24px">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:10px;color:#999;line-height:1.6">무료 현장 실측 · 전문 디자이너 상담<br><span style="font-size:9px;color:#ccc">TOV HOUSE · tovdesign.net</span></td>
      <td style="text-align:right"><a href="tel:010-6202-3618" style="background:#1d55a0;color:#fff;text-decoration:none;font-size:11px;font-weight:600;padding:10px 18px;border-radius:4px;display:inline-block">010-6202-3618</a></td>
    </tr></table>
  </td></tr>
</table>
</td></tr></table>
</body>
</html>`;

  const raw = Buffer.from(
    `From: TOV HOUSE <2001p@naver.com>\r\n` +
      `To: ${data.email}\r\n` +
      `Subject: =?UTF-8?B?${Buffer.from("TOV HOUSE 상담 접수 완료").toString("base64")}?=\r\n` +
      `Content-Type: text/html; charset=utf-8\r\n\r\n` +
      htmlBody,
  ).toString("base64url");

  if (data.email) {
    await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
    console.log("Confirm email sent to", data.email);
  }

  // --- 내부수신 이메일 (2001p@naver.com) ---
  const iTs = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  const iRid = "#C-" + Date.now().toString(36).toUpperCase();
  const scheduleHtml = data.schedule
    ? '<span style="font-size:9px;background:#e8eef5;color:#1d55a0;padding:2px 6px">' +
      data.schedule +
      "</span>"
    : "-";
  const messageHtml = data.message
    ? '<tr><td style="padding:0 24px"><div style="border-top:1px solid #e8e8e6"></div></td></tr>' +
      '<tr><td style="padding:12px 24px">' +
      '<p style="margin:0 0 6px;font-size:9px;font-weight:700;color:#999;letter-spacing:2px">요청 내용</p>' +
      '<p style="margin:0;font-size:11px;color:#555;line-height:1.7;background:#fafaf8;padding:10px 12px;border-radius:4px">' +
      data.message +
      "</p>" +
      "</td></tr>"
    : "";

  var r = function (label, val) {
    return (
      '<tr><td style="padding:5px 0;color:#999;font-size:10px;width:60px;vertical-align:top">' +
      label +
      '</td><td style="padding:5px 0;font-size:11px">' +
      val +
      "</td></tr>"
    );
  };
  var sep =
    '<tr><td colspan="2" style="border-top:1px solid #f0efed"></td></tr>';

  const internalHtml =
    '<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    '<body style="margin:0;padding:0;background:#e8e8e6;font-family:-apple-system,sans-serif">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="background:#e8e8e6;padding:16px"><tr><td align="center">' +
    '<table cellpadding="0" cellspacing="0" style="background:#fff;max-width:460px;width:100%">' +
    '<tr><td style="background:linear-gradient(135deg,#12396b,#1d55a0);padding:12px 16px">' +
    '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td style="font-size:10px;font-weight:700;color:#fff;letter-spacing:2px">TOV ADMIN</td>' +
    '<td style="text-align:right;font-size:9px;color:rgba(255,255,255,0.5)">' +
    iRid +
    "</td>" +
    "</tr></table></td></tr>" +
    '<tr><td style="padding:14px 16px 10px">' +
    '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td><p style="margin:0;font-size:14px;font-weight:700;color:#1a1a1a">새 상담 접수</p><p style="margin:4px 0 0;font-size:10px;color:#999">' +
    iTs +
    "</p></td>" +
    '<td style="text-align:right"><span style="font-size:10px;font-weight:700;background:#faf5eb;color:#c4a265;padding:4px 10px;border-radius:3px">NEW</span></td>' +
    "</tr></table></td></tr>" +
    '<tr><td style="padding:0 16px"><div style="border-top:1px solid #e8e8e6"></div></td></tr>' +
    '<tr><td style="padding:10px 16px">' +
    '<table width="100%" cellpadding="0" cellspacing="0" style="color:#1a1a1a">' +
    r("이름", "<b>" + data.name + "</b>") +
    r("연락처", data.phone) +
    r("이메일", data.email || "-") +
    sep +
    r("종류", data.interiorType || "-") +
    r("예산", data.budget || "-") +
    r("평수", data.area || "-") +
    sep +
    r("지역", data.address || "-") +
    r("시기", scheduleHtml) +
    r("사진", photoCount + "장") +
    "</table></td></tr>" +
    messageHtml +
    '<tr><td style="background:#f5f5f3;padding:10px 16px;text-align:center">' +
    '<p style="margin:0;font-size:9px;color:#ccc">TOV HOUSE 내부 알림 · <a href="https://admin.tovdesign.net/#leads" style="color:#1d55a0;text-decoration:none">접수 관리 바로가기</a></p>' +
    "</td></tr></table></td></tr></table></body></html>";

  const INTERNAL_RECIPIENTS = [
    "2001p@naver.com",
    "d13650@naver.com",
    "mkt@polarad.co.kr",
  ];
  const subjectB64 = Buffer.from("[TOV] 새 상담 접수 - " + data.name).toString(
    "base64",
  );

  for (const recipient of INTERNAL_RECIPIENTS) {
    const raw2 = Buffer.from(
      "From: TOV HOUSE <drdo6890ys@gmail.com>\r\n" +
        "To: " +
        recipient +
        "\r\n" +
        "Subject: =?UTF-8?B?" +
        subjectB64 +
        "?=\r\n" +
        "Content-Type: text/html; charset=utf-8\r\n\r\n" +
        internalHtml,
    ).toString("base64url");
    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: raw2 },
    });
    console.log("Internal email sent to", recipient);
  }
}

module.exports = async (req, res) => {
  // CORS
  const origin = req.headers.origin || "";
  const allowed = [
    "https://tovdesign.net",
    "https://www.tovdesign.net",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
  ];
  if (allowed.includes(origin))
    res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    let data;
    try {
      data = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }

    // Validate required fields
    if (!data.name || !data.name.trim()) {
      return res.status(400).json({ error: "이름을 입력해주세요." });
    }
    if (!data.phone || !data.phone.trim()) {
      return res.status(400).json({ error: "연락처를 입력해주세요." });
    }

    // Upload photos to R2
    const photos = Array.isArray(data.photos) ? data.photos : [];
    const timestamp = Date.now();
    const photoUrls = [];
    for (let i = 0; i < photos.length; i++) {
      if (!photos[i] || !photos[i].startsWith("data:")) continue;
      try {
        const key = `submissions/${timestamp}_${i}.webp`;
        const url = await uploadPhoto(photos[i], key);
        photoUrls.push(url);
      } catch (err) {
        console.error(`Photo upload failed for index ${i}:`, err);
      }
    }

    // Save to Airtable
    try {
      const clientIp =
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        req.headers["x-real-ip"] ||
        "";
      await saveToAirtable(data, photoUrls, clientIp);
    } catch (err) {
      console.error("Airtable save failed:", err.message, err.stack);
      return res.status(500).json({
        error: "접수 저장 실패: " + (err.message || "").substring(0, 200),
      });
    }

    // Telegram + LMS + emails must complete before response (Vercel kills process after res)
    const telegramP = sendTelegram(data, photoUrls.length, "web").catch((err) =>
      console.error("Telegram send failed:", err),
    );
    // SMS는 Worker를 통해 발송 (Vercel에서 SENS 환경변수 문제)
    const lmsP = fetch(
      "https://tovhouse.2343parksw.workers.dev/api/send-sms",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      },
    ).catch((err) => console.error("Worker SMS failed:", err));

    try {
      await sendEmails(data, photoUrls.length);
    } catch (err) {
      console.error("Email send failed:", err);
    }

    await Promise.all([telegramP, lmsP]);

    return res.status(200).json({ success: true });
  } catch (globalErr) {
    console.error("Unhandled submit error:", globalErr);
    return res.status(500).json({ error: globalErr.message || "서버 오류" });
  }
};
