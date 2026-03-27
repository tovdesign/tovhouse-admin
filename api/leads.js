const BASE_URL = () =>
  `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}`;
const headers = () => ({
  Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
  "Content-Type": "application/json",
});

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

function mapRecord(record) {
  const f = record.fields;
  const g = (key) => f[key] || "";
  return {
    id: record.id,
    name: g("Name"),
    phone: g("phone"),
    email: g("email"),
    interiorType: g("interiorType"),
    budget: g("budget"),
    area: g("area"),
    address: g("address"),
    schedule: g("schedule"),
    message: g("message"),
    photos: (f.photos || []).map((p) => {
      if (typeof p === "string") return p;
      // Use R2 permanent URL from filename, fallback to Airtable temp URL
      if (p.filename)
        return (
          (process.env.R2_PUBLIC_URL ||
            "https://pub-64e468fed30d4c00aefa275f39dd9f92.r2.dev") +
          "/submissions/" +
          p.filename
        );
      return p.url;
    }),
    status: g("status") || "대기",
    memo: g("memo"),
    platform: g("platform"),
    ip: g("ip"),
    privacyConsent: !!f.privacyConsent,
    createdAt: g("createdAt") || record.createdTime,
  };
}

module.exports = async (req, res) => {
  if (!verifyToken(req)) return res.status(401).json({ error: "인증 필요" });

  // GET - list all leads (paginate through Airtable, sort by createdTime)
  if (req.method === "GET") {
    try {
      let all = [];
      let aOffset = null;
      do {
        let url = `${BASE_URL()}?pageSize=100`;
        if (aOffset) url += `&offset=${aOffset}`;
        const r = await fetch(url, { headers: headers() });
        if (!r.ok) throw new Error(`Airtable: ${r.status}`);
        const data = await r.json();
        all = all.concat(
          (data.records || []).map((rec) => {
            const mapped = mapRecord(rec);
            mapped._createdTime = rec.createdTime;
            return mapped;
          }),
        );
        aOffset = data.offset;
      } while (aOffset);

      // Sort by createdAt or Airtable createdTime (newest first)
      all.sort((a, b) => {
        const da = new Date(a.createdAt || a._createdTime || 0);
        const db = new Date(b.createdAt || b._createdTime || 0);
        return db - da;
      });

      return res.json({
        records: all,
        total: all.length,
      });
    } catch (err) {
      console.error("Leads GET error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // PATCH - update status/memo
  if (req.method === "PATCH") {
    try {
      const { recordId, id, status, memo, memoAuthor, memoText, customerName } =
        req.body;
      const rid = recordId || id;
      if (!rid) return res.status(400).json({ error: "recordId 필요" });

      const fields = {};
      if (status) fields.status = status;
      if (memo !== undefined) fields.memo = memo;

      const r = await fetch(`${BASE_URL()}/${rid}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ fields }),
      });
      if (!r.ok) throw new Error(`Airtable: ${r.status}`);
      const data = await r.json();

      // Send Telegram notification for new memo
      if (memoText && process.env.TELEGRAM_BOT_TOKEN) {
        const name = customerName || data.fields?.Name || "-";
        const author = memoAuthor || "관리자";
        const text = `📝 *메모 추가*\n\n👤 고객: ${name}\n✍️ ${author}: ${memoText.substring(0, 200)}\n\n[접수 관리 →](https://admin.tovdesign.net/#leads)`;
        fetch(
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
        ).catch((err) => console.error("Telegram memo notify failed:", err));
      }

      return res.json({ success: true, record: mapRecord(data) });
    } catch (err) {
      console.error("Leads PATCH error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // DELETE - delete lead
  if (req.method === "DELETE") {
    try {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: "id 필요" });

      const r = await fetch(`${BASE_URL()}/${id}`, {
        method: "DELETE",
        headers: headers(),
      });
      if (!r.ok) throw new Error(`Airtable: ${r.status}`);
      return res.json({ success: true, deleted: id });
    } catch (err) {
      console.error("Leads DELETE error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
};
