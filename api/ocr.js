const { google } = require("googleapis");

function verifyToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return false;
  try {
    const payload = JSON.parse(
      Buffer.from(auth.split(" ")[1], "base64").toString(),
    );
    if (Date.now() - payload.ts > 7 * 24 * 60 * 60 * 1000) return false;
    return true;
  } catch {
    return false;
  }
}

function getPrivateKey() {
  if (process.env.GA4_PRIVATE_KEY) return process.env.GA4_PRIVATE_KEY;
  if (process.env.GA4_PRIVATE_KEY_B64) {
    return Buffer.from(process.env.GA4_PRIVATE_KEY_B64, "base64").toString(
      "utf8",
    );
  }
  return null;
}

function getAuth() {
  const key = getPrivateKey();
  if (!key) throw new Error("No private key configured");
  return new google.auth.JWT({
    email: process.env.GA4_CLIENT_EMAIL,
    key,
    scopes: ["https://www.googleapis.com/auth/cloud-vision"],
  });
}

// Parse OCR text into receipt items [{item, amount}]
function parseReceiptItems(text) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const items = [];
  // Common patterns: "항목명  금액" or "항목명 ... 1,234,567" or table rows
  const amountRegex = /[\d,]+(?:\.\d+)?(?:\s*원)?$/;
  const numberOnly = /^[\d,.\s원]+$/;

  for (const line of lines) {
    // Skip header/total lines
    if (/^(합계|총|계|소계|부가세|VAT|total)/i.test(line)) {
      const match = line.match(/([\d,]+)/);
      if (match) {
        items.push({
          item: line.replace(/([\d,]+)/, "").trim() || "합계",
          amount: formatAmount(match[1]),
        });
      }
      continue;
    }

    // Skip lines that are only numbers or empty
    if (numberOnly.test(line) || line.length < 2) continue;

    // Try to extract "item name ... amount"
    const match = line.match(/^(.+?)\s{2,}([\d,]+(?:\.\d+)?(?:\s*원)?)$/);
    if (match) {
      items.push({
        item: match[1].trim(),
        amount: formatAmount(match[2]),
      });
      continue;
    }

    // Try tab-separated
    const tabMatch = line.match(/^(.+?)\t+([\d,]+(?:\.\d+)?(?:\s*원)?)$/);
    if (tabMatch) {
      items.push({
        item: tabMatch[1].trim(),
        amount: formatAmount(tabMatch[2]),
      });
      continue;
    }

    // Try "항목 금액" at end of line
    const endMatch = line.match(
      /^(.{2,}?)\s+([\d]{1,3}(?:,\d{3})+(?:\s*원)?)$/,
    );
    if (endMatch) {
      items.push({
        item: endMatch[1].trim(),
        amount: formatAmount(endMatch[2]),
      });
    }
  }

  return items;
}

function formatAmount(raw) {
  const num = raw.replace(/[^0-9]/g, "");
  if (!num) return raw;
  return parseInt(num, 10).toLocaleString("ko-KR") + "원";
}

module.exports = async (req, res) => {
  // CORS
  const origin = req.headers.origin || "";
  const allowed = [
    "https://admin.tovdesign.net",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
  ];
  if (allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });
  if (!verifyToken(req)) return res.status(401).json({ error: "인증 필요" });

  try {
    const { imageUrl, imageBase64 } = req.body;
    if (!imageUrl && !imageBase64) {
      return res.status(400).json({ error: "imageUrl 또는 imageBase64 필요" });
    }

    const auth = getAuth();
    const vision = google.vision({ version: "v1", auth });

    let request;
    if (imageBase64) {
      // Strip data URI prefix if present
      const content = imageBase64.replace(/^data:image\/\w+;base64,/, "");
      request = {
        requests: [
          {
            image: { content },
            features: [{ type: "TEXT_DETECTION", maxResults: 1 }],
          },
        ],
      };
    } else {
      request = {
        requests: [
          {
            image: { source: { imageUri: imageUrl } },
            features: [{ type: "TEXT_DETECTION", maxResults: 1 }],
          },
        ],
      };
    }

    const result = await vision.images.annotate({ requestBody: request });
    const annotations = result.data.responses?.[0];

    if (annotations?.error) {
      return res.status(400).json({
        error: "Vision API error: " + annotations.error.message,
      });
    }

    const fullText = annotations?.fullTextAnnotation?.text || "";

    if (!fullText) {
      return res.json({
        success: true,
        rawText: "",
        items: [],
        message: "텍스트를 인식하지 못했습니다",
      });
    }

    const items = parseReceiptItems(fullText);

    return res.json({
      success: true,
      rawText: fullText,
      items,
      itemCount: items.length,
    });
  } catch (err) {
    console.error("OCR error:", err);
    return res.status(500).json({ error: err.message });
  }
};
