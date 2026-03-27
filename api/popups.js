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

// 팝업 데이터는 Airtable 별도 테이블에 저장
// AIRTABLE_POPUP_TABLE must be set to the actual Airtable table ID (e.g. tblXXXXXXXX)
const BASE_URL = () => {
  const tableId = process.env.AIRTABLE_POPUP_TABLE;
  if (!tableId) throw new Error("AIRTABLE_POPUP_TABLE 미설정");
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${tableId}`;
};
const headers = () => ({
  Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
  "Content-Type": "application/json",
});

function mapPopup(record) {
  const f = record.fields;
  return {
    id: record.id,
    title: f.title || "",
    imageUrl: f.imageUrl || "",
    linkUrl: f.linkUrl || "",
    active: f.active === true || f.active === "true",
    startDate: f.startDate || "",
    endDate: f.endDate || "",
    createdAt: f.createdAt || record.createdTime,
  };
}

module.exports = async (req, res) => {
  // GET - public (no auth required for fetching active popups)
  if (req.method === "GET" && req.query.public === "true") {
    try {
      const url = `${BASE_URL()}?filterByFormula=${encodeURIComponent("{active}=TRUE()")}`;
      const r = await fetch(url, { headers: headers() });
      if (!r.ok) throw new Error(`Airtable: ${r.status}`);
      const data = await r.json();
      const now = new Date().toISOString().slice(0, 10);
      const popups = (data.records || []).map(mapPopup).filter((p) => {
        if (p.startDate && p.startDate > now) return false;
        if (p.endDate && p.endDate < now) return false;
        return true;
      });
      return res.json({ popups });
    } catch (err) {
      return res.json({ popups: [] });
    }
  }

  // Admin endpoints require auth
  if (!verifyToken(req)) return res.status(401).json({ error: "인증 필요" });

  // GET - list all popups (admin)
  if (req.method === "GET") {
    try {
      const r = await fetch(
        `${BASE_URL()}?sort%5B0%5D%5Bfield%5D=createdAt&sort%5B0%5D%5Bdirection%5D=desc`,
        { headers: headers() },
      );
      if (!r.ok) throw new Error(`Airtable: ${r.status}`);
      const data = await r.json();
      return res.json({ popups: (data.records || []).map(mapPopup) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST - create popup
  if (req.method === "POST") {
    try {
      const { title, imageUrl, linkUrl, active, startDate, endDate } = req.body;
      const r = await fetch(BASE_URL(), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          records: [
            {
              fields: {
                title,
                imageUrl,
                linkUrl,
                active: active !== false,
                startDate: startDate || "",
                endDate: endDate || "",
                createdAt: new Date().toLocaleString("ko-KR", {
                  timeZone: "Asia/Seoul",
                }),
              },
            },
          ],
        }),
      });
      if (!r.ok) throw new Error(`Airtable: ${r.status}`);
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // PATCH - update popup
  if (req.method === "PATCH") {
    try {
      const { recordId, ...fields } = req.body;
      if (!recordId) return res.status(400).json({ error: "recordId 필요" });
      const r = await fetch(`${BASE_URL()}/${recordId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ fields }),
      });
      if (!r.ok) throw new Error(`Airtable: ${r.status}`);
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // DELETE - delete popup
  if (req.method === "DELETE") {
    try {
      const { recordId } = req.body;
      if (!recordId) return res.status(400).json({ error: "recordId 필요" });
      const r = await fetch(`${BASE_URL()}/${recordId}`, {
        method: "DELETE",
        headers: headers(),
      });
      if (!r.ok) throw new Error(`Airtable: ${r.status}`);
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
};
