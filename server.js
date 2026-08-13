import express from "express";
import * as cheerio from "cheerio";

const app = express();

const SERPER_API_KEY = (process.env.SERPER_API_KEY || "").trim();
const SCRAPER_API_KEY = (process.env.SCRAPER_API_KEY || "").trim();

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "7.0.0",
  name: "TVNetil Direct Streams",
  description: "Direct Search on TVNetil via ScraperAPI -> Extract HTML Title -> Serper Fave -> Streams",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"]
};

/* =========================================================
   TEXT UTILS & CLEANING
========================================================= */

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function cleanText(value) {
  return decodeHtml(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTVNetilTitle(rawTitle) {
  if (!rawTitle) return "";
  return cleanText(rawTitle)
    .replace(/\s*[-|–—]\s*TVNetil.*$/iu, "")
    .replace(/^TVNetil\.net\s*[-|:]\s*/iu, "")
    .replace(/\s*[-|–—]\s*סרטים.*$/iu, "")
    .trim();
}

function extractUrlsFromText(text) {
  const value = String(text || "");
  const urls = value.match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  return urls.map(url => url.replace(/[.,;!?]+$/g, "").trim());
}

/* =========================================================
   SERPER SEARCH (משמש רק עבור Favez0ne)
========================================================= */

async function serperSearch(query, num = 20) {
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
   שלב 1+2: פנייה ישירה ל-TVNetil דרך ScraperAPI וחילוץ הכותרת
========================================================= */

async function searchAndExtractTVNetilTitle(hebrewTitle) {
  console.log("[שלב 1] פנייה ישירה ל-TVNetil דרך ScraperAPI עבור:", hebrewTitle);

  if (!SCRAPER_API_KEY) {
    throw new Error("SCRAPER_API_KEY is missing in environment variables");
  }

  // פנייה ישירה למנוע החיפוש הפנימי של TVNetil
  const tvnetilSearchUrl = `https://www.tvnetil.net/index.php?act=search&CODE=01&q=${encodeURIComponent(hebrewTitle)}`;
  const scraperUrl = `https://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(tvnetilSearchUrl)}`;

  const response = await fetch(scraperUrl);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ScraperAPI HTTP ${response.status}: ${errText.substring(0, 300)}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  // חילוץ הכותרת מתוך תוצאות החיפוש ב-HTML של TVNetil
  let exactTitle =
    $("h1.entry-title").text() ||
    $(".review-header h1").text() ||
    $(".title-review").text() ||
    $(".search-result a").first().text() ||
    $("h1").first().text() ||
    $("title").text() ||
    "";

  exactTitle = cleanTVNetilTitle(exactTitle);

  if (!exactTitle || exactTitle.toLowerCase().includes("just a moment")) {
    throw new Error("לא נמצאה כותרת תקינה ב-TVNetil או שהבקשה נחסמה");
  }

  console.log("[שלב 2] הכותרת המדויקת שחולצה מ-TVNetil:", exactTitle);
  return { exactTitle, tvnetilSearchUrl };
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
  let tvnetilSearchUrl = "";

  // 1+2. פנייה ישירה ל-TVNetil דרך ScraperAPI וחילוץ הכותרת בעברית
  try {
    const scraped = await searchAndExtractTVNetilTitle(hebrewTitle);
    exactTitle = scraped.exactTitle;
    tvnetilSearchUrl = scraped.tvnetilSearchUrl;
  } catch (err) {
    return {
      success: false,
      step: "tvnetil-scrape-failed",
      error: err.message,
      streams: []
    };
  }

  // 3. חיפוש ב-Favez0ne עם הכותרת המדויקת באמצעות Serper
  console.log("[שלב 3] מחפש ב-Favez0ne עבור הכותרת:", exactTitle);
  const faveData = await serperSearch(`site:favez0ne.net "${exactTitle}"`, 20);
  let organic = Array.isArray(faveData?.organic) ? faveData.organic : [];

  if (!organic.length) {
    const fallbackFave = await serperSearch(`site:favez0ne.net ${exactTitle}`, 20);
    organic = Array.isArray(fallbackFave?.organic) ? fallbackFave.organic : [];
  }

  if (!organic.length || !organic[0].link) {
    return {
      success: false,
      step: "fave-page-not-found",
      tvnetilSearchUrl,
      exactTitle,
      streams: []
    };
  }

  const faveUrl = organic[0].link;

  // 4. חילוץ הסטרימים (PixelDrain / GoFile)
  const streams = await scrapeFaveToNuvioStreams(faveUrl, exactTitle);

  return {
    success: streams.length > 0,
    hebrewTitle,
    tvnetilSearchUrl,
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
app.get("/", (_, res) => res.send("TVNetil Direct Streams 7.0.0"));

app.listen(process.env.PORT || 3000);
export default app;
