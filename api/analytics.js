const BASE_ID = process.env.AIRTABLE_BASE_ID;
const API_KEY = process.env.AIRTABLE_API_KEY;

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

function isGA4Configured() {
  return !!(
    process.env.GA4_PROPERTY_ID &&
    process.env.GA4_CLIENT_EMAIL &&
    (process.env.GA4_PRIVATE_KEY || process.env.GA4_PRIVATE_KEY_B64)
  );
}

function emptyData(period, startDate, endDate) {
  return {
    connected: false,
    period,
    startDate,
    endDate,
    totals: { users: 0, pageViews: 0, avgDuration: 0 },
    daily: [],
    sources: [],
    devices: [],
    pages: [],
    regions: [],
  };
}

// GA4 Realtime API - active users right now
async function getRealtimeUsers() {
  const { google } = require("googleapis");
  const propertyId = process.env.GA4_PROPERTY_ID;

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GA4_CLIENT_EMAIL,
      private_key: process.env.GA4_PRIVATE_KEY_B64
        ? Buffer.from(process.env.GA4_PRIVATE_KEY_B64, "base64").toString(
            "utf-8",
          )
        : (process.env.GA4_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
  });

  const analyticsData = google.analyticsdata({ version: "v1beta", auth });

  const res = await analyticsData.properties.runRealtimeReport({
    property: `properties/${propertyId}`,
    requestBody: {
      metrics: [{ name: "activeUsers" }],
    },
  });

  const activeUsers =
    parseInt((res.data.rows || [])[0]?.metricValues?.[0]?.value) || 0;
  return { connected: true, activeUsers };
}

// GA4 Data API via googleapis
async function getGA4Data(startDate, endDate) {
  const { google } = require("googleapis");
  const propertyId = process.env.GA4_PROPERTY_ID;

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GA4_CLIENT_EMAIL,
      private_key: process.env.GA4_PRIVATE_KEY_B64
        ? Buffer.from(process.env.GA4_PRIVATE_KEY_B64, "base64").toString(
            "utf-8",
          )
        : (process.env.GA4_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
  });

  const analyticsData = google.analyticsdata({ version: "v1beta", auth });

  // Batch reports
  const [dailyRes, sourcesRes, devicesRes, pagesRes, regionsRes] =
    await Promise.all([
      // Daily visitors
      analyticsData.properties.runReport({
        property: `properties/${propertyId}`,
        requestBody: {
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: "date" }],
          metrics: [
            { name: "activeUsers" },
            { name: "screenPageViews" },
            { name: "averageSessionDuration" },
          ],
          orderBys: [{ dimension: { dimensionName: "date" } }],
        },
      }),
      // Traffic sources
      analyticsData.properties.runReport({
        property: `properties/${propertyId}`,
        requestBody: {
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: "sessionDefaultChannelGroup" }],
          metrics: [{ name: "sessions" }],
          limit: 10,
        },
      }),
      // Devices
      analyticsData.properties.runReport({
        property: `properties/${propertyId}`,
        requestBody: {
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: "deviceCategory" }],
          metrics: [{ name: "activeUsers" }],
        },
      }),
      // Top pages
      analyticsData.properties.runReport({
        property: `properties/${propertyId}`,
        requestBody: {
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: "pagePath" }],
          metrics: [{ name: "screenPageViews" }],
          orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
          limit: 10,
        },
      }),
      // Geographic regions - city level for Korea, country for overseas
      analyticsData.properties.runReport({
        property: `properties/${propertyId}`,
        requestBody: {
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: "country" }, { name: "city" }],
          metrics: [{ name: "activeUsers" }],
          orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
          limit: 30,
        },
      }),
    ]);

  // Parse daily data
  const daily = (dailyRes.data.rows || []).map((row) => ({
    date: row.dimensionValues[0].value,
    users: parseInt(row.metricValues[0].value) || 0,
    pageViews: parseInt(row.metricValues[1].value) || 0,
    avgDuration: parseFloat(row.metricValues[2].value) || 0,
  }));

  // Parse sources (한글 변환)
  const sourceKo = {
    "Organic Search": "검색 유입",
    Direct: "직접 방문",
    Referral: "추천 링크",
    "Organic Social": "SNS 유입",
    "Paid Search": "검색 광고",
    "Paid Social": "SNS 광고",
    Email: "이메일",
    Display: "디스플레이 광고",
    Unassigned: "미분류",
    "Cross-network": "크로스네트워크",
    "Organic Video": "영상 유입",
    "Organic Shopping": "쇼핑 유입",
  };
  const sources = (sourcesRes.data.rows || []).map((row) => ({
    source:
      sourceKo[row.dimensionValues[0].value] || row.dimensionValues[0].value,
    sessions: parseInt(row.metricValues[0].value) || 0,
  }));

  // Parse devices (한글 변환)
  const deviceKo = { desktop: "데스크톱", mobile: "모바일", tablet: "태블릿" };
  const devices = (devicesRes.data.rows || []).map((row) => ({
    device:
      deviceKo[row.dimensionValues[0].value] || row.dimensionValues[0].value,
    users: parseInt(row.metricValues[0].value) || 0,
  }));

  // Parse pages
  const pages = (pagesRes.data.rows || []).map((row) => ({
    path: row.dimensionValues[0].value,
    views: parseInt(row.metricValues[0].value) || 0,
  }));

  // Parse regions - city level for Korea, country for overseas
  const rawRegions = (regionsRes.data.rows || []).map((row) => ({
    country: row.dimensionValues[0].value,
    city: row.dimensionValues[1].value,
    users: parseInt(row.metricValues[0].value) || 0,
  }));
  // Group: Korea = show city (한글), overseas = show country (한글)
  const cityKo = {
    Seoul: "서울",
    Busan: "부산",
    Incheon: "인천",
    Daegu: "대구",
    Daejeon: "대전",
    Gwangju: "광주",
    Ulsan: "울산",
    Sejong: "세종",
    Suwon: "수원",
    Goyang: "고양",
    Seongnam: "성남",
    Bucheon: "부천",
    Ansan: "안산",
    Yongin: "용인",
    Anyang: "안양",
    Gimpo: "김포",
    Hwaseong: "화성",
    Pyeongtaek: "평택",
    Cheongju: "청주",
    Jeonju: "전주",
    Changwon: "창원",
    Jeju: "제주",
    Wonju: "원주",
    Chuncheon: "춘천",
    Paju: "파주",
    Siheung: "시흥",
    Gunpo: "군포",
    Gwangmyeong: "광명",
    Cheongna: "청라",
    Songdo: "송도",
    Bupyeong: "부평",
    Guri: "구리",
    Hanam: "하남",
    Osan: "오산",
    Icheon: "이천",
    Yangju: "양주",
    "(not set)": "미확인",
  };
  const countryKo = {
    "South Korea": "대한민국",
    "United States": "미국",
    Japan: "일본",
    China: "중국",
    "United Kingdom": "영국",
    Canada: "캐나다",
    Australia: "호주",
    Germany: "독일",
    France: "프랑스",
    Vietnam: "베트남",
    Thailand: "태국",
    Singapore: "싱가포르",
  };
  const regionMap = {};
  rawRegions.forEach((r) => {
    const isKorea =
      r.country === "South Korea" ||
      r.country === "Korea" ||
      r.country === "대한민국";
    let label;
    if (isKorea) {
      // GA4 returns "Bucheon-si", "Incheon", "Seoul" etc - strip -si/-gu/-dong suffix
      const cityClean = (r.city || "").replace(/-(si|gu|dong|gun|myeon)$/i, "");
      label = cityKo[cityClean] || cityKo[r.city] || r.city || "기타";
      if (!label || label === "(not set)") label = "미확인";
    } else {
      label = countryKo[r.country] || r.country;
    }
    if (label) regionMap[label] = (regionMap[label] || 0) + r.users;
  });
  const regions = Object.entries(regionMap)
    .map(([region, users]) => ({ region, users }))
    .sort((a, b) => b.users - a.users);

  // Totals
  const totalUsers = daily.reduce((s, d) => s + d.users, 0);
  const totalPageViews = daily.reduce((s, d) => s + d.pageViews, 0);
  const avgDuration = daily.length
    ? daily.reduce((s, d) => s + d.avgDuration, 0) / daily.length
    : 0;

  return {
    connected: true,
    startDate,
    endDate,
    totals: {
      users: totalUsers,
      pageViews: totalPageViews,
      avgDuration: Math.round(avgDuration),
    },
    daily,
    sources,
    devices,
    pages,
    regions,
  };
}

module.exports = async (req, res) => {
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });
  if (!verifyToken(req)) return res.status(401).json({ error: "인증 필요" });

  // Health check / not configured - still return self-tracked data
  if (!isGA4Configured()) {
    const period = parseInt(req.query.period) || 7;
    const endDate = new Date().toISOString().slice(0, 10);
    const startD = new Date();
    startD.setDate(startD.getDate() - period);
    const startDate = startD.toISOString().slice(0, 10);
    try {
      const selfData = await getSelfTrackedStats(startDate, endDate);
      return res.json({ connected: false, ...selfData, period });
    } catch (e) {
      return res.json({ connected: false, period });
    }
  }

  // Realtime active users
  if (req.query.realtime === "true") {
    try {
      const data = await getRealtimeUsers();
      return res.json(data);
    } catch (err) {
      console.error("Realtime analytics error:", err);
      return res.json({ connected: false, activeUsers: 0, error: err.message });
    }
  }

  // Resolve date range
  let startDate, endDate, periodLabel;
  if (req.query.startDate && req.query.endDate) {
    // Custom date range
    startDate = req.query.startDate;
    endDate = req.query.endDate;
    periodLabel = "custom";
  } else {
    const period = parseInt(req.query.period) || 7;
    if (period === 1) {
      startDate = "today";
      endDate = "today";
    } else {
      startDate = `${period}daysAgo`;
      endDate = "today";
    }
    periodLabel = period;
  }

  try {
    const data = await getGA4Data(startDate, endDate);
    // Merge: GA4 regions + self-tracked regions (구 단위 보강)
    const selfRegions = await getSelfTrackedRegions(startDate, endDate);
    if (selfRegions.length > 0) {
      // Merge: self-tracked 우선, GA4로 보완
      const merged = {};
      selfRegions.forEach((r) => {
        merged[r.region] = (merged[r.region] || 0) + r.users;
      });
      (data.regions || []).forEach((r) => {
        if (!merged[r.region]) merged[r.region] = r.users;
      });
      data.regions = Object.entries(merged)
        .map(([region, users]) => ({ region, users }))
        .sort((a, b) => b.users - a.users);
    }
    return res.json({ ...data, period: periodLabel });
  } catch (err) {
    console.error("Analytics error:", err);
    const fallback = emptyData(periodLabel, startDate, endDate);
    const selfRegions = await getSelfTrackedRegions(startDate, endDate).catch(
      () => [],
    );
    if (selfRegions.length > 0) fallback.regions = selfRegions;
    return res.json({ ...fallback, error: err.message });
  }
};

// Full self-tracked stats from Airtable visitors table
async function getSelfTrackedStats(startDate, endDate) {
  const VISITORS_URL = `https://api.airtable.com/v0/${BASE_ID}/visitors`;
  const filter = encodeURIComponent(
    `AND({date}>='${startDate}',{date}<='${endDate}')`,
  );
  let all = [],
    offset = null;
  do {
    const url = `${VISITORS_URL}?filterByFormula=${filter}&pageSize=100${offset ? "&offset=" + offset : ""}`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const d = await r.json();
    all = all.concat(d.records || []);
    offset = d.offset;
  } while (offset);

  // Daily aggregation
  const dailyMap = {};
  all.forEach((r) => {
    const date = r.fields.date || "";
    if (!dailyMap[date]) dailyMap[date] = { date, users: 0, pageViews: 0 };
    dailyMap[date].users++;
    dailyMap[date].pageViews++;
  });
  const daily = Object.values(dailyMap).sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  // Regions (city + district) with Korean fallback for English data
  const _cityKo = {
    Seoul: "서울",
    Busan: "부산",
    Incheon: "인천",
    Daegu: "대구",
    Daejeon: "대전",
    Gwangju: "광주",
    Ulsan: "울산",
    Sejong: "세종",
    Suwon: "수원",
    Goyang: "고양",
    Seongnam: "성남",
    Bucheon: "부천",
    Ansan: "안산",
    Yongin: "용인",
    Anyang: "안양",
    Gimpo: "김포",
    Hwaseong: "화성",
    Pyeongtaek: "평택",
    Cheongju: "청주",
    Jeonju: "전주",
    Changwon: "창원",
    Jeju: "제주",
    Paju: "파주",
    Siheung: "시흥",
    Namyangju: "남양주",
    Cheonan: "천안",
    "Santa Clara": "산타클라라",
  };
  const _distKo = {
    "Wonmi-gu": "원미구",
    "Sosa-gu": "소사구",
    "Ojeong-gu": "오정구",
    "Jung-gu": "중구",
    "Dong-gu": "동구",
    "Michuhol-gu": "미추홀구",
    "Yeonsu-gu": "연수구",
    "Namdong-gu": "남동구",
    "Bupyeong-gu": "부평구",
    "Gyeyang-gu": "계양구",
    "Seo-gu": "서구",
    "Gangnam-gu": "강남구",
    "Mapo-gu": "마포구",
    "Seocho-gu": "서초구",
    "Songpa-gu": "송파구",
  };
  function toKo(str) {
    if (!str) return "";
    return (
      _cityKo[str.replace(/-(si|gu|dong|gun)$/i, "")] ||
      _distKo[str] ||
      _cityKo[str] ||
      str
    );
  }
  const _regionKo = {
    "Gyeonggi-do": "경기도",
    "Gangwon-do": "강원도",
    "Chungcheongbuk-do": "충북",
    "Chungcheongnam-do": "충남",
    "Jeollabuk-do": "전북",
    "Jeollanam-do": "전남",
    "Gyeongsangbuk-do": "경북",
    "Gyeongsangnam-do": "경남",
    "Jeju-do": "제주",
  };
  const _countryKo = {
    "United States": "미국",
    Japan: "일본",
    China: "중국",
    "United Kingdom": "영국",
    Canada: "캐나다",
    Australia: "호주",
    Germany: "독일",
    France: "프랑스",
    Vietnam: "베트남",
    Thailand: "태국",
    Singapore: "싱가포르",
    India: "인도",
    Russia: "러시아",
    Brazil: "브라질",
    Indonesia: "인도네시아",
    Philippines: "필리핀",
    Malaysia: "말레이시아",
    Taiwan: "대만",
  };
  const koRegions = [
    "경기도",
    "강원도",
    "충북",
    "충남",
    "전북",
    "전남",
    "경북",
    "경남",
    "제주",
    "Gyeonggi-do",
    "Gangwon-do",
    "Seoul",
    "Incheon",
    "Busan",
    "Daegu",
    "Daejeon",
    "Gwangju",
    "Ulsan",
    "Sejong",
  ];
  const regionMap = {};
  all.forEach((r) => {
    const rawCity = r.fields.city || "";
    const rawDist = r.fields.district || "";
    const rawRegion = r.fields.region || "";
    const city = toKo(rawCity) || rawCity;
    const district = toKo(rawDist) || rawDist;
    const isKorea =
      koRegions.some((k) => rawRegion.includes(k) || rawCity.includes(k)) ||
      !rawRegion;
    let label;
    if (isKorea) {
      label = district ? `${city} ${district}` : city || "미확인";
    } else {
      const country = _countryKo[rawRegion] || rawRegion;
      label = city ? `${country} ${city}` : country;
    }
    regionMap[label] = (regionMap[label] || 0) + 1;
  });
  const regions = Object.entries(regionMap)
    .map(([region, users]) => ({ region, users }))
    .sort((a, b) => b.users - a.users);

  // Devices
  const deviceMap = {};
  all.forEach((r) => {
    const dev = r.fields.device === "mobile" ? "모바일" : "데스크톱";
    deviceMap[dev] = (deviceMap[dev] || 0) + 1;
  });
  const devices = Object.entries(deviceMap).map(([device, users]) => ({
    device,
    users,
  }));

  // Pages
  const pageMap = {};
  all.forEach((r) => {
    const p = r.fields.page || "/";
    pageMap[p] = (pageMap[p] || 0) + 1;
  });
  const pages = Object.entries(pageMap)
    .map(([path, views]) => ({ path, views }))
    .sort((a, b) => b.views - a.views);

  // Sources (referrer)
  const srcMap = {};
  all.forEach((r) => {
    const ref = r.fields.referrer || "";
    let label = "직접 방문";
    if (ref.includes("google")) label = "검색 유입";
    else if (ref.includes("naver")) label = "네이버";
    else if (ref.includes("instagram") || ref.includes("facebook"))
      label = "SNS 유입";
    else if (ref && ref !== "") label = "추천 링크";
    srcMap[label] = (srcMap[label] || 0) + 1;
  });
  const sources = Object.entries(srcMap)
    .map(([source, sessions]) => ({ source, sessions }))
    .sort((a, b) => b.sessions - a.sessions);

  const totalUsers = all.length;
  return {
    totals: { users: totalUsers, pageViews: totalUsers, avgDuration: 0 },
    daily,
    regions,
    devices,
    pages,
    sources,
  };
}

// Self-tracked visitor regions from Airtable (구 단위)
async function getSelfTrackedRegions(startDate, endDate) {
  const VISITORS_URL = `https://api.airtable.com/v0/${BASE_ID}/visitors`;
  try {
    // Calculate actual dates
    let fromDate, toDate;
    if (startDate === "today") {
      fromDate = toDate = new Date().toISOString().slice(0, 10);
    } else if (startDate.includes("daysAgo")) {
      const days = parseInt(startDate);
      const d = new Date();
      d.setDate(d.getDate() - days);
      fromDate = d.toISOString().slice(0, 10);
      toDate = new Date().toISOString().slice(0, 10);
    } else {
      fromDate = startDate;
      toDate = endDate || new Date().toISOString().slice(0, 10);
    }

    const filter = encodeURIComponent(
      `AND({date}>='${fromDate}',{date}<='${toDate}')`,
    );
    let all = [],
      offset = null;
    do {
      const url = `${VISITORS_URL}?filterByFormula=${filter}&pageSize=100${offset ? "&offset=" + offset : ""}`;
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      const d = await r.json();
      all = all.concat(d.records || []);
      offset = d.offset;
    } while (offset);

    // Aggregate by city+district (Korean conversion for English data)
    const cKo = {
      Seoul: "서울",
      Busan: "부산",
      Incheon: "인천",
      Bucheon: "부천",
      Gimpo: "김포",
      Suwon: "수원",
      Ansan: "안산",
      Goyang: "고양",
      Paju: "파주",
      Siheung: "시흥",
      Hwaseong: "화성",
      Seongnam: "성남",
      Anyang: "안양",
    };
    const dKo = {
      "Wonmi-gu": "원미구",
      "Sosa-gu": "소사구",
      "Ojeong-gu": "오정구",
      "Bupyeong-gu": "부평구",
      "Seo-gu": "서구",
      "Namdong-gu": "남동구",
      "Gyeyang-gu": "계양구",
      "Yeonsu-gu": "연수구",
    };
    const ctKo2 = {
      "United States": "미국",
      Japan: "일본",
      China: "중국",
      Germany: "독일",
      France: "프랑스",
      Canada: "캐나다",
      Australia: "호주",
      "United Kingdom": "영국",
      Vietnam: "베트남",
      Singapore: "싱가포르",
      California: "미국",
      India: "인도",
      Taiwan: "대만",
    };
    const koR2 = [
      "경기도",
      "강원도",
      "충북",
      "충남",
      "전북",
      "전남",
      "경북",
      "경남",
      "제주",
      "Gyeonggi-do",
      "Seoul",
      "Incheon",
      "Busan",
    ];
    function _ko(s) {
      return (
        cKo[(s || "").replace(/-(si|gu|dong|gun)$/i, "")] ||
        dKo[s] ||
        cKo[s] ||
        s
      );
    }
    const regionMap = {};
    all.forEach((r) => {
      const rawCity = r.fields.city || "";
      const rawDist = r.fields.district || "";
      const rawRegion = r.fields.region || "";
      const city = _ko(rawCity) || rawCity;
      const district = _ko(rawDist) || rawDist;
      const isKorea =
        koR2.some((k) => rawRegion.includes(k) || rawCity.includes(k)) ||
        !rawRegion;
      let label;
      if (isKorea) {
        label = district ? `${city} ${district}` : city || "미확인";
      } else {
        const country = ctKo2[rawRegion] || rawRegion;
        label = rawCity ? `${country} ${_ko(rawCity)}` : country;
      }
      regionMap[label] = (regionMap[label] || 0) + 1;
    });

    return Object.entries(regionMap)
      .map(([region, users]) => ({ region, users }))
      .sort((a, b) => b.users - a.users);
  } catch (e) {
    console.error("Self-tracked regions error:", e);
    return [];
  }
}
