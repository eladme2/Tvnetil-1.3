import express from "express";
import * as cheerio from "cheerio";

const app = express();

const SCRAPER_API_KEY = (process.env.SCRAPER_API_KEY || "").trim();

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "10.8.0",
  name: "TVNetil Direct Streams",
  description: "Strict Clean Hebrew Logic - No Double Decoding Corruption",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"]
};

/* =========================================================
   UTILS & ENCODING FIXES
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

// בודק אם המחרוזת מכילה ג'יבריש/סימני קידוד פגום
function isCorruptedText(str) {
  if (!str) return true;
  // זיהוי תווים משובשים אופייניים לבעיות encoding בעברית
  return /[׳ֲ¿½\uFFFD]/.test(str);
}

function cleanTvnetilHeaderTitle(rawTitle) {
  if (!rawTitle) return "";
  let title = decodeHtmlEntities(rawTitle).trim();

  title = title
    .replace(/\s*[-|–—:]\s*TVNetil.*$/iu, "")
    .replace(/^TVNetil\.net\s*[-|:]\s*/iu, "")
    .replace(/\s*[-|–—:]\s*סרטים.*$/iu, "")
    .replace(/\s*[-|–—:]\s*סדרות.*$/iu, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();

  return title;
}

function extractUrlsFromText(text) {
  const value = String(text || "");
  const urls = value.match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  return urls.map(url => url.replace(/[.,;!?]+$/g, "").trim());
}

/* =========================================================
   SCRAPER API WRAPPER
========================================================= */

async function fetchPageHtml(targetUrl) {
  if (!SCRAPER_API_KEY) throw new Error("SCRAPER_API_KEY is missing");

  const scraperUrl = `https://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}`;
  const response = await fetch(scraperUrl);

  if (!response.ok) {
    throw new Error(`ScraperAPI HTTP ${response.status} for ${targetUrl}`);
  }

  return await response.text();
}

/* =========================================================
   שלב 1 + 2: איתור TVNetil והרכבת כותרת תקינה בעברית
========================================================= */

async function getTvnetilDetails(hebrewTitle) {
  console.log("[שלב 1 - Nuvio Title] שם מ-Nuvio:", hebrewTitle);

  const searchUrl = `https://www.tvnetil.net/index.php?act=search&CODE=01&q=${encodeURIComponent(hebrewTitle)}`;
  const searchHtml = await fetchPageHtml(searchUrl);
  const $search = cheerio.load(searchHtml);

  let tvnetilPageUrl = "";

  $search("a[href*='/review/']").each((_, el) => {
    const href = $search(el).attr("href");
    if (href && !tvnetilPageUrl) {
      tvnetilPageUrl = href.startsWith("http") ? href : `https://www.tvnetil.net${href.startsWith("/") ? "" : "/"}${href}`;
    }
  });

  if (!tvnetilPageUrl) {
    throw new Error(`שלב 1 נכשל: לא נמצא עמוד ב-TVNetil עבור השם "${hebrewTitle}"`);
  }

  console.log("[שלב 2 - TVNetil HTML] נכנס לדף להעתקת כותרת:", tvnetilPageUrl);
  const pageHtml = await fetchPageHtml(tvnetilPageUrl);
  const $page = cheerio.load(pageHtml);

  const rawTitle =
    $page("h1.entry-title").text() ||
    $page(".review-header h1").text() ||
    $page(".title-review").text() ||
    $page("h1").first().text() ||
    "";

  let exactTitleFromTvnetil = cleanTvnetilHeaderTitle(rawTitle);

  // מנגנון הגנה: בדיקה אם חילוץ הכותרת החזיר ג'יבריש
  if (isCorruptedText(exactTitleFromTvnetil)) {
    console.log("[שלב 2 - אזהרה] הכותרת מ-TVNetil פגומה. מחלץ שנה בלבד ומשלב עם שם Nuvio.");
    
    // חילוץ שנה (למשל 2025) מתוך הטקסט
    const yearMatch = exactTitleFromTvnetil.match(/\b(19\d\d|20\d\d)\b/);
    const extractedYear = yearMatch ? ` (${yearMatch[1]})` : "";

    exactTitleFromTvnetil = `${hebrewTitle}${extractedYear}`.trim();
  }

  console.log("[שלב 2 - כותרת סופית מתוכננת]:", exactTitleFromTvnetil);
  return { tvnetilPageUrl, exactTitleFromTvnetil };
}

/* =========================================================
   שלב 3: חיפוש ממוקד ב-Favez0ne
========================================================= */

async function searchFavez0ne(exactTitleFromTvnetil, originalNuvioTitle) {
  let faveSearchTerm = exactTitleFromTvnetil
    .replace(/\s*[-|–—:]\s*(מדובב|מתורגם|תרגום מובנה|איכות|1080p|720p|HD|WEBRip|BDRip).*$/iu, "")
    .trim();

  console.log("[שלב 3 - Favez0ne] חיפוש ב-Favez0ne עם:", faveSearchTerm);

  let faveSearchUrl = `https://favez0ne.net/?s=${encodeURIComponent(faveSearchTerm)}`;
  let html = await fetchPageHtml(faveSearchUrl);
  let $ = cheerio.load(html);

  let favePostUrl = "";

  $("a[href*='favez0ne.net']").each((_, el) => {
    const href = $(el).attr("href");
    if (href && href.includes("/20") && !favePostUrl && !href.includes("?s=")) {
      favePostUrl = href;
    }
  });

  // ניסיון גיבוי עם שם Nuvio
  if (!favePostUrl && faveSearchTerm !== originalNuvioTitle) {
    console.log("[שלב 3 - Favez0ne] ניסיון גיבוי עם שם Nuvio:", originalNuvioTitle);
    faveSearchUrl = `https://favez0ne.net/?s=${encodeURIComponent(originalNuvioTitle)}`;
    html = await fetchPageHtml(faveSearchUrl);
    $ = cheerio.load(html);

    $("a[href*='favez0ne.net']").each((_, el) => {
      const href = $(el).attr("href");
      if (href && href.includes("/20") && !favePostUrl && !href.includes("?s=")) {
        favePostUrl = href;
      }
    });
    if (favePostUrl) faveSearchTerm = originalNuvioTitle;
  }

  if (!favePostUrl) {
    throw new Error(`שלב 3 נכשל: לא נמצא פוסט ב-Favez0ne עבור השאילתה "${faveSearchTerm}"`);
  }

  console.log("[שלב 3 - הצלחה] נמצא פוסט ב-Favez0ne:", favePostUrl);
  return { favePostUrl, faveSearchTerm };
}

/* =========================================================
   שלב 4: משיכת קישורי צפייה ישירים
========================================================= */

function normalizePixelDrainUrl(url) {
  let value = String(url || "").trim().replace(/[.,;!?]+$/g, "");
  if (!value) return null;

  try {
    const parsed = new URL(value);
    if (!parsed.hostname.toLowerCase().includes("pixeldrain.com")) return null;
    const match = parsed.pathname.match(/^\/(api\/file|u|l)\/([A-Za-z0-9_-]+)/i);
    if (match) return `https://pixeldrain.com/api/file/${match[2]}`;
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
    if (!parsed.hostname.toLowerCase().includes("gofile.io")) return null;
    const match = parsed.pathname.match(/^\/d\/([A-Za-z0-9_-]+)/i);
    if (match) return `https://gofile.io/d/${match[1]}`;
  } catch {
    return null;
  }
  return null;
}

async function extractStreamsFromFavePage(faveUrl, exactTitle) {
  console.log("[שלב 4 - קישורי Favez0ne] מנסה לחלץ PixelDrain/GoFile מתוך:", faveUrl);
  const html = await fetchPageHtml(faveUrl);
  const $ = cheerio.load(html);

  const streams = [];
  const seenUrls = new Set();

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

  return streams;
}

/* =========================================================
   MAIN PIPELINE
========================================================= */

async function resolveDirectFlow(hebrewTitle) {
  try {
    const { tvnetilPageUrl, exactTitleFromTvnetil } = await getTvnetilDetails(hebrewTitle);
    const { favePostUrl, faveSearchTerm } = await searchFavez0ne(exactTitleFromTvnetil, hebrewTitle);
    const streams = await extractStreamsFromFavePage(favePostUrl, exactTitleFromTvnetil);

    return {
      success: streams.length > 0,
      pipeline: {
        step1_nuvioTitle: hebrewTitle,
        step2_tvnetilPageUrl: tvnetilPageUrl,
        step2_exactTitleFromTvnetilPage: exactTitleFromTvnetil,
        step3_faveSearchTermUsed: faveSearchTerm,
        step3_favePostUrl: favePostUrl,
        step4_extractedStreamsCount: streams.length
      },
      streams
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      streams: []
    };
  }
}

/* =========================================================
   ROUTES
========================================================= */

app.get("/test-title", async (req, res) => {
  const title = String(req.query.q || "").trim();
  if (!title) return res.json({ success: false, message: "Use ?q=שם" });

  return res.json(await resolveDirectFlow(title));
});

app.get("/manifest.json", (_, res) => res.json(MANIFEST));
app.get("/", (_, res) => res.send("TVNetil Direct Streams 10.8.0"));

app.listen(process.env.PORT || 3000);
export default app;
