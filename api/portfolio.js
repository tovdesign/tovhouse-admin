const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

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

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const API_KEY = process.env.AIRTABLE_TOKEN;
const TABLE = "portfolio";
const BASE_URL = `https://api.airtable.com/v0/${BASE_ID}/${TABLE}`;
const R2_PUBLIC =
  process.env.R2_PUBLIC_URL ||
  "https://pub-5208781873524f8f8f342badb8f4a47a.r2.dev";

const CORS_ORIGINS = [
  "https://tovdesign.net",
  "https://www.tovdesign.net",
  "https://admin.tovdesign.net",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

function setCors(req, res) {
  const origin = req.headers.origin || "";
  if (CORS_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function getS3() {
  return new S3Client({
    region: "auto",
    endpoint: process.env.R2_S3_API,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

async function uploadBase64ToR2(base64, key) {
  const data = base64.replace(/^data:image\/\w+;base64,/, "");
  const buffer = Buffer.from(data, "base64");
  await getS3().send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: "image/webp",
      CacheControl: "public, max-age=31536000",
    }),
  );
  return `${R2_PUBLIC}/${key}`;
}

async function airtableFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `Airtable ${res.status}: ${JSON.stringify(data.error || data)}`,
    );
  }
  return data;
}

async function getAllRecords() {
  let all = [];
  let offset = null;
  do {
    const url = offset
      ? `${BASE_URL}?pageSize=100&offset=${offset}&sort%5B0%5D%5Bfield%5D=sortOrder&sort%5B0%5D%5Bdirection%5D=desc`
      : `${BASE_URL}?pageSize=100&sort%5B0%5D%5Bfield%5D=sortOrder&sort%5B0%5D%5Bdirection%5D=desc`;
    const data = await airtableFetch(url);
    all = all.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return all;
}

function mapRecord(r) {
  const f = r.fields;
  return {
    id: r.id,
    title: f.title || "",
    cat: f.category || "",
    subcategory: f.subcategory || "",
    img: f.thumbnail || "",
    images: f.images ? f.images.split("\n").filter(Boolean) : [],
    description: f.description || "",
    content: f.content || "",
    blocks: f.blocks || "",
    receipt_image: f.receipt_image || "",
    receipt_data: f.receipt_data || "",
    region: f.region || "",
    spaceType: f.spaceType || "",
    area: f.area || "",
    duration: f.duration || "",
    cost: f.cost || "",
    contractor_name: f.contractor_name || "",
    contractor_phone: f.contractor_phone || "",
    sortOrder: f.sortOrder || 0,
    visible: !!f.visible,
  };
}

async function uploadImagesBackground(recordId, thumbBase64, imageBase64s) {
  const ts = Date.now();
  const fields = {};

  try {
    if (thumbBase64) {
      const key = `images/portfolio/admin/${ts}/thumb.webp`;
      const url = await uploadBase64ToR2(thumbBase64, key);
      fields.thumbnail = url;
    }

    if (imageBase64s && imageBase64s.length) {
      const urls = [];
      for (let i = 0; i < imageBase64s.length; i++) {
        const key = `images/portfolio/admin/${ts}/${i + 1}.webp`;
        const url = await uploadBase64ToR2(imageBase64s[i], key);
        urls.push(url);
      }
      const existing = await airtableFetch(`${BASE_URL}/${recordId}`);
      const existingImgs = existing.fields?.images
        ? existing.fields.images.split("\n").filter(Boolean)
        : [];
      fields.images = [...existingImgs, ...urls].join("\n");
    }

    if (Object.keys(fields).length) {
      await airtableFetch(BASE_URL, {
        method: "PATCH",
        body: JSON.stringify({ records: [{ id: recordId, fields }] }),
      });
    }
  } catch (err) {
    console.error("Background image upload error:", err);
  }
}

module.exports = async (req, res) => {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // GET - public list or single item
  if (req.method === "GET") {
    const adminMode = verifyToken(req);
    const singleId = req.query?.id;

    try {
      // Single record by ID
      if (singleId) {
        const data = await airtableFetch(`${BASE_URL}/${singleId}`);
        const item = mapRecord(data);
        if (!adminMode && !item.visible) {
          return res.status(404).json({ error: "not found" });
        }
        // Hide contractor info from public
        if (!adminMode) {
          delete item.contractor_name;
          delete item.contractor_phone;
        }
        return res.json({ item });
      }

      // All records
      const records = await getAllRecords();
      const items = records
        .filter((r) => adminMode || r.fields.visible)
        .map((r) => {
          const m = mapRecord(r);
          if (!adminMode) {
            delete m.contractor_name;
            delete m.contractor_phone;
          }
          return m;
        });
      return res.json({ items, total: items.length });
    } catch (err) {
      console.error("Portfolio GET error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Auth required for write operations
  if (!verifyToken(req)) return res.status(401).json({ error: "인증 필요" });

  // POST - add new portfolio item
  if (req.method === "POST") {
    try {
      const {
        title,
        category,
        cat,
        thumbnail,
        thumbnailUrl,
        images,
        imageUrls,
        description,
        content,
        blocks,
        receipt_image,
        receipt_data,
        region,
        spaceType,
        area,
        duration,
        cost,
        contractor_name,
        contractor_phone,
        thumbBase64,
        imageBase64s,
      } = req.body;
      const catValue = category || cat;
      const thumbValue = thumbnail || thumbnailUrl;
      const imgsValue = images || imageUrls || [];

      if (!title || !catValue)
        return res.status(400).json({ error: "제목, 카테고리 필요" });

      const records = await getAllRecords();
      const maxOrder = records.reduce(
        (max, r) => Math.max(max, r.fields.sortOrder || 0),
        0,
      );

      const fieldData = {
        title,
        category: catValue,
        thumbnail: thumbValue || "",
        images: Array.isArray(imgsValue)
          ? imgsValue.join("\n")
          : imgsValue || "",
        description: description || "",
        content: content || "",
        blocks: blocks || "",
        sortOrder: maxOrder + 1,
        visible: true,
      };
      if (receipt_image) fieldData.receipt_image = receipt_image;
      if (receipt_data) fieldData.receipt_data = receipt_data;
      if (region !== undefined) fieldData.region = region;
      if (spaceType !== undefined) fieldData.spaceType = spaceType;
      if (area !== undefined) fieldData.area = area;
      if (duration !== undefined) fieldData.duration = duration;
      if (cost !== undefined) fieldData.cost = cost;
      if (contractor_name !== undefined)
        fieldData.contractor_name = contractor_name;
      if (contractor_phone !== undefined)
        fieldData.contractor_phone = contractor_phone;

      const data = await airtableFetch(BASE_URL, {
        method: "POST",
        body: JSON.stringify({ records: [{ fields: fieldData }] }),
      });

      const recordId = data.records?.[0]?.id;

      if (recordId && (thumbBase64 || (imageBase64s && imageBase64s.length))) {
        await uploadImagesBackground(recordId, thumbBase64, imageBase64s);
      }

      res.json({ success: true, id: recordId });
    } catch (err) {
      console.error("Portfolio POST error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // PATCH - update portfolio item
  else if (req.method === "PATCH") {
    try {
      const {
        id,
        title,
        category,
        cat,
        thumbnail,
        thumbnailUrl,
        images,
        imageUrls,
        description,
        content,
        blocks,
        receipt_image,
        receipt_data,
        region,
        spaceType,
        area,
        duration,
        cost,
        contractor_name,
        contractor_phone,
        visible,
        sortOrder,
        thumbBase64,
        imageBase64s,
      } = req.body;
      if (!id) return res.status(400).json({ error: "id 필요" });

      const fields = {};
      if (title !== undefined) fields.title = title;
      if (category || cat) fields.category = category || cat;
      if (thumbnail || thumbnailUrl)
        fields.thumbnail = thumbnail || thumbnailUrl;
      if (images || imageUrls) {
        const imgs = images || imageUrls;
        fields.images = Array.isArray(imgs) ? imgs.join("\n") : imgs;
      }
      if (description !== undefined) fields.description = description;
      if (content !== undefined) fields.content = content;
      if (blocks !== undefined) fields.blocks = blocks;
      if (receipt_image !== undefined) fields.receipt_image = receipt_image;
      if (receipt_data !== undefined) fields.receipt_data = receipt_data;
      if (region !== undefined) fields.region = region;
      if (spaceType !== undefined) fields.spaceType = spaceType;
      if (area !== undefined) fields.area = area;
      if (duration !== undefined) fields.duration = duration;
      if (cost !== undefined) fields.cost = cost;
      if (contractor_name !== undefined)
        fields.contractor_name = contractor_name;
      if (contractor_phone !== undefined)
        fields.contractor_phone = contractor_phone;
      if (visible !== undefined) fields.visible = visible;
      if (sortOrder !== undefined) fields.sortOrder = sortOrder;

      if (Object.keys(fields).length) {
        await airtableFetch(BASE_URL, {
          method: "PATCH",
          body: JSON.stringify({ records: [{ id, fields }] }),
        });
      }

      if (thumbBase64 || (imageBase64s && imageBase64s.length)) {
        await uploadImagesBackground(id, thumbBase64, imageBase64s);
      }

      res.json({ success: true });
    } catch (err) {
      console.error("Portfolio PATCH error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // PUT - bulk update sortOrder
  else if (req.method === "PUT") {
    try {
      const { orders } = req.body;
      if (!Array.isArray(orders) || orders.length === 0)
        return res.status(400).json({ error: "orders 배열 필요" });

      for (let i = 0; i < orders.length; i += 10) {
        const batch = orders.slice(i, i + 10).map((o) => ({
          id: o.id,
          fields: { sortOrder: o.sortOrder },
        }));
        await airtableFetch(BASE_URL, {
          method: "PATCH",
          body: JSON.stringify({ records: batch }),
        });
      }
      return res.json({ success: true, updated: orders.length });
    } catch (err) {
      console.error("Portfolio PUT (reorder) error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  // DELETE - delete portfolio item
  else if (req.method === "DELETE") {
    try {
      const id = req.query?.id || req.body?.id;
      if (!id) return res.status(400).json({ error: "id 필요" });

      await airtableFetch(`${BASE_URL}/${id}`, { method: "DELETE" });
      return res.json({ success: true });
    } catch (err) {
      console.error("Portfolio DELETE error:", err);
      return res.status(500).json({ error: err.message });
    }
  } else {
    return res.status(405).json({ error: "Method not allowed" });
  }
};
