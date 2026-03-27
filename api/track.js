const crypto = require("crypto");

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const API_KEY = process.env.AIRTABLE_API_KEY;
const TABLE = "visitors";
const BASE_URL = `https://api.airtable.com/v0/${BASE_ID}/${TABLE}`;

function hashIP(ip) {
  return crypto
    .createHash("sha256")
    .update(ip + (process.env.IP_SALT || "tovd"))
    .digest("hex")
    .slice(0, 16);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST only" });

  try {
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      "";
    const ipHash = hashIP(ip);
    const {
      city: rawCity,
      district: rawDistrict,
      region: rawRegion,
      page,
      device,
      referrer,
    } = req.body || {};

    // 영문 → 한글 변환
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
      Guri: "구리",
      Hanam: "하남",
      Osan: "오산",
      Icheon: "이천",
      Yangju: "양주",
      Uijeongbu: "의정부",
      Gwacheon: "과천",
      Pocheon: "포천",
      Namyangju: "남양주",
      Dongducheon: "동두천",
      Asan: "아산",
      Cheonan: "천안",
      Iksan: "익산",
      Gunsan: "군산",
      Mokpo: "목포",
      Yeosu: "여수",
      Jinju: "진주",
      Gimhae: "김해",
      Yangsan: "양산",
      Geoje: "거제",
    };
    const districtKo = {
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
      "Ganghwa-gun": "강화군",
      "Ongjin-gun": "옹진군",
      "Gangnam-gu": "강남구",
      "Gangdong-gu": "강동구",
      "Gangbuk-gu": "강북구",
      "Gangseo-gu": "강서구",
      "Gwanak-gu": "관악구",
      "Gwangjin-gu": "광진구",
      "Guro-gu": "구로구",
      "Geumcheon-gu": "금천구",
      "Nowon-gu": "노원구",
      "Dobong-gu": "도봉구",
      "Dongdaemun-gu": "동대문구",
      "Dongjak-gu": "동작구",
      "Mapo-gu": "마포구",
      "Seodaemun-gu": "서대문구",
      "Seocho-gu": "서초구",
      "Seongdong-gu": "성동구",
      "Seongbuk-gu": "성북구",
      "Songpa-gu": "송파구",
      "Yangcheon-gu": "양천구",
      "Yeongdeungpo-gu": "영등포구",
      "Yongsan-gu": "용산구",
      "Eunpyeong-gu": "은평구",
      "Jongno-gu": "종로구",
      "Jungnang-gu": "중랑구",
    };
    const regionKo = {
      "Gyeonggi-do": "경기도",
      "Gangwon-do": "강원도",
      "Chungcheongbuk-do": "충청북도",
      "Chungcheongnam-do": "충청남도",
      "Jeollabuk-do": "전라북도",
      "Jeollanam-do": "전라남도",
      "Gyeongsangbuk-do": "경상북도",
      "Gyeongsangnam-do": "경상남도",
      "Jeju-do": "제주도",
    };

    const cleanCity = (rawCity || "").replace(/-(si|gu|dong|gun|myeon)$/i, "");
    const cleanDistrict = (rawDistrict || "").replace(/-(gu|dong)$/i, "");
    const city = cityKo[cleanCity] || cityKo[rawCity] || rawCity || "";
    const district =
      districtKo[rawDistrict] || districtKo[cleanDistrict] || rawDistrict || "";
    const region = regionKo[rawRegion] || rawRegion || "";

    // Deduplicate: same ipHash + same date = skip
    const today = new Date().toISOString().slice(0, 10);
    const checkUrl = `${BASE_URL}?filterByFormula=AND({ipHash}='${ipHash}',{date}='${today}')&maxRecords=1`;
    const checkRes = await fetch(checkUrl, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const checkData = await checkRes.json();
    if (checkData.records && checkData.records.length > 0) {
      return res.json({ ok: true, dup: true });
    }

    // Save
    await fetch(BASE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        records: [
          {
            fields: {
              date: today,
              ipHash,
              city: city || "",
              district: district || "",
              region: region || "",
              page: page || "/",
              device: device || "",
              referrer: referrer || "",
            },
          },
        ],
      }),
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("Track error:", e);
    return res.status(500).json({ error: e.message });
  }
};
