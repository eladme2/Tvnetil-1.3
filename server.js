import express from "express";
import * as cheerio from "cheerio";

const app = express();

const SERPER_API_KEY = (process.env.SERPER_API_KEY || "").trim();

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "8.0.0",
  name: "TVNetil Direct Streams",
  description: "Serper TVNetil Title Scrape -> Fave -> Direct Streams",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"]
};

/* =========================================================
   TEXT UTILS
========================================================= */

function decodeHtmlEntities(str) {
  return String(str || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function cleanTvnetilTitleFromGoogle(rawTitle) {
  if (!rawTitle) return "";
  let title = decodeHtmlEntities(rawTitle).trim();

  // הסרת סיומות אתר נפוצות מגוגל
  title = title
    .replace(/\s*[-|–—:]\s*TVNetil.*$/iu, "")
    .replace(/^TVNetil\.net\s*[-|:]\s*/iu, "")
    .replace(/\s*[-|–—:]\s*סרטים.*$/iu, "")
    .replace(/\s*[-|–—:]\s*סדרות.*$/iu, "")
    .trim();

  return title;
}

function extractUrlsFromText(text) {
  const value = String(text || "");
  const urls = value.match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  return urls.map(url => url.replace(/[.,;!?]+$/g, "").trim());
}

/* =========================================================
   SERPER SEARCH
========================================================= */

async function serperSearch(query, num = 10) {
  if (!SERPER_API_KEY) throw new Error("SERPER_API_KEY is missing");

  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": SERPER_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ q: query, gl: "il", hl: "he", num })
  });

  return await response.json();
}

/* =========================================================
   שלב 1: מציאת הכותרת המדויקת ב-TVNetil דרך Serper
========================================================= */

async function getExactTitleFromTvnetilGoogle(hebrewTitle) {
  console.log("[שלב 1] מחפש את עמוד הסרט ב-TVNetil דרך Serper עבור:", hebrewTitle);

  const searchData = await serperSearch(`site:tvnetil.net/review/ "${hebrewTitle}"`, 10);
  let organic = Array.isArray(searchData?.organic) ? searchData.organic : [];

  if (!organic.length) {
    const fallbackData = await serperSearch(`site:tvnetil.net "${hebrewTitle}"`, 10);
    organic = Array.isArray(fallbackData?.organic) ? fallbackData.organic : [];
  }

  if (!organic.length || !organic[0].title) {
    console.log("[שלב 1] לא נמצא עמוד ב-TVNetil, משתמש בשם המקורי:", hebrewTitle);
    return { exactTitle: hebrewTitle, tvnetilUrl: "" };
  }

  const rawTitle = organic[0].title;
  const tvnetilUrl = organic[0].link || "";
  const exactTitle = cleanTvnetilTitleFromGoogle(rawTitle);

  console.log("[שלב 2] הכותרת המדויקת שנמצאה:", exactTitle);
  return { exactTitle, tvnetilUrl };
}

/* =========================================================
   STREAM PARSING FOR NUVIO
========================================================= */

function normalizePixelDrainUrl(url) {
  let value = String(url || "").trim().replace(/[.,;!?]+$/g, "");
  if (!value) return null;

  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes("pixeldrain.com")) return null;

    const apiMatch = parsed.pathname.match(/^\/api\/file\/([A-Za-z0-9_-]+)\/?$/i);
    if (apiMatch) return `https://pixeldrain.com/api/file/${apiMatch[1]}`;

    const userMatch = parsed.pathname.match(/^\/u\/([A-Za-z0-9_-]+)\/?$/i);
    if (userMatch) return `https://pixeldrain.com/api/file/${userMatch[1]}`;

    const fileMatch = parsed.pathname.match(/^\/l\/([A-Za-z0-9_-]+)\/?$/i);
    if (fileMatch) return `https://pixeldrain.com/api/file/${fileMatch[1]}`;
  } catch {
    return null;
  }
  return null;
}

function normalizeGoFileUrl(url) {
  let value = String(url || "").trim().replace(/[.,;!?]+$/g, "");
  if (!value) return null;

  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes("gofile.io")) return null;

    const match = parsed.pathname.match(/^\/d\/([A-Za-z0-9_-]+)\/?$/i);
    if (match) return `https://gofile.io/d/${match[1]}`;
  } catch {
    return null;
  }
  return null;
}

async function scrapeFaveToNuvioStreams(faveUrl, exactTitle) {
  console.log("[שלב 4] סורק את עמוד ה-Fave לקבלת קישורי צפייה:", faveUrl);
  const streams = [];
  const seenUrls = new Set();

  try {
    const response = await fetch(faveUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36"
      }
    });

    if (!response.ok) return streams;

    const html = await response.text();
    const $ = cheerio.load(html);

    const pageUrls = [];
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (href) pageUrls.push(href);
    });

    const combinedUrls = Array.from(new Set([...pageUrls, ...extractUrlsFromText(html)]));

    for (const rawUrl of combinedUrls) {
      const pixelUrl = normalizePixelDrainUrl(rawUrl);
      if (pixelUrl && !seenUrls.has(pixelUrl)) {
        seenUrls.add(pixelUrl);
        streams.push({
          name: "TVNetil Direct",
          title: `⚡ PixelDrain | ${exactTitle}`,
          url: pixelUrl,
          type: "http"
        });
      }

      const gofileUrl = normalizeGoFileUrl(rawUrl);
      if (gofileUrl && !seenUrls.has(gofileUrl)) {
        seenUrls.add(gofileUrl);
        streams.push({
          name: "TVNetil Direct",
          title: `🚀 GoFile | ${exactTitle}`,
          url: gofileUrl,
          type: "http"
        });
      }
    }
  } catch (err) {
    console.error("Fave Scrape Error:", err.message);
  }

  return streams;
}

/* =========================================================
   MAIN FLOW
========================================================= */

async function resolveTVNetil(hebrewTitle) {
  let exactTitle = "";
  let tvnetilUrl = "";

  try {
    const scraped = await getExactTitleFromTvnetilGoogle(hebrewTitle);
    exactTitle = scraped.exactTitle;
    tvnetilUrl = scraped.tvnetilUrl;
  } catch (err) {
    return {
      success: false,
      step: "tvnetil-search-failed",
      error: err.message,
      streams: []
    };
  }

  console.log("[שלב 3] מחפש ב-Favez0ne עבור הכותרת המקורית:", exactTitle);
  const faveData = await serperSearch(`site:favez0ne.net "${exactTitle}"`, 10);
  let organic = Array.isArray(faveData?.organic) ? faveData.organic : [];

  if (!organic.length) {
    // חיפוש מורחב בלי מרכאות
    const fallbackFave = await serperSearch(`site:favez0ne.net ${hebrewTitle}`, 10);
    organic = Array.isArray(fallbackFave?.organic) ? fallbackFave.organic : [];
  }

  if (!organic.length || !organic[0].link) {
    return {
      success: false,
      step: "fave-page-not-found",
      tvnetilUrl,
      exactTitle,
      streams: []
    };
  }

  const faveUrl = organic[0].link;
  const streams = await scrapeFaveToNuvioStreams(faveUrl, exactTitle);

  return {
    success: streams.length > 0,
    hebrewTitle,
    tvnetilUrl,
    exactTitle,
    faveUrl,
    streams
  };
}

/* =========================================================
   ROUTES
========================================================= */

app.get("/test-title", async (req, res) => {
  const title = String(req.query.q || "").trim();
  if (!title) return res.json({ success: false, message: "Use ?q=שם" });

  try {
    return res.json(await resolveTVNetil(title));
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, streams: [] });
  }
});

app.get("/manifest.json", (_, res) => res.json(MANIFEST));
app.get("/", (_, res) => res.send("TVNetil Direct Streams 8.0.0"));

app.listen(process.env.PORT || 3000);
export default app;
