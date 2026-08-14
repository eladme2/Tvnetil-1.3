import express from "express";
import * as cheerio from "cheerio";

const app = express();

const SCRAPER_API_KEY = (process.env.SCRAPER_API_KEY || "").trim();

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "10.6.0",
  name: "TVNetil Direct Streams",
  description: "Strict Flow with Windows-1255 Encoding Fix & Clean Favez0ne Search",
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

// תיקון קריטי: מנקה ג'יבריש ומבטיח מחרוזת עברית נקייה ב-UTF-8
function fixHebrewEncoding(str) {
  if (!str) return "";
  let clean = decodeHtmlEntities(str);

  // הסרת תווי ג'יבריש נפוצים מהמרות Windows-1255 פגומות
  clean = clean.replace(/[\uFFFD\u007F-\u009F׳Ÿֲ¿ֲ½]/g, "");

  // הסרת תווים בלתי נראים
  clean = clean.replace(/[\u200B-\u200D\uFEFF]/g, "");

  return clean.trim();
}

function cleanTvnetilHeaderTitle(rawTitle) {
  if (!rawTitle) return "";
  let title = fixHebrewEncoding(rawTitle);

  // הסרת סיומות אתר TVNetil בלבד
  title = title
    .replace(/\s*[-|–—:]\s*TVNetil.*$/iu, "")
    .replace(/^TVNetil\.net\s*[-|:]\s*/iu, "")
    .replace(/\s*[-|–—:]\s*סרטים.*$/iu, "")
    .replace(/\s*[-|–—:]\s*סדרות.*$/iu, "")
    .trim();

  return title;
}

// חותך סיומות תרגום/דיבוב ומחזיר "שם (שנה)"
function formatTitleForFavez0ne(titleFromTvnetil) {
  if (!titleFromTvnetil) return "";
  
  return titleFromTvnetil
    .replace(/\s*[-|–—:]\s*(מדובב|מתורגם|תרגום מובנה|איכות|1080p|720p|HD|WEBRip|BDRip).*$/iu, "")
    .trim();
}

function extractUrlsFromText(text) {
  const value = String(text || "");
  const urls = value.match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  return urls.map(url => url.replace(/[.,;!?]+$/g, "").trim());
}

/* =========================================================
   SCRAPER API WRAPPER
========================================================= */

async function fetchPageHtml(targetUrl, isWindows1255 = false) {
  if (!SCRAPER_API_KEY) throw new Error("SCRAPER_API_KEY is missing");

  const scraperUrl = `https://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}&binary=true`;
  const response = await fetch(scraperUrl);

  if (!response.ok) {
    throw new Error(`ScraperAPI HTTP ${response.status} for ${targetUrl}`);
  }

  const buffer = await response.arrayBuffer();

  if (isWindows1255) {
    // פענוח מפורש מ-windows-1255 ל-utf-8
    let html = new TextDecoder("windows-1255").decode(buffer);
    if (!/[\u0590-\u05FF]/.test(html)) {
      html = new TextDecoder("utf-8").decode(buffer);
    }
    return html;
  }

  return new TextDecoder("utf-8").decode(buffer);
}

/* =========================================================
   שלב 1 + 2: איתור TVNetil והוצאת הכותרת המדויקת מהדף
========================================================= */

async function getTvnetilDetails(hebrewTitle) {
  console.log("[שלב 1 - Nuvio Title] שם מ-Nuvio:", hebrewTitle);

  const searchUrl = `https://www.tvnetil.net/index.php?act=search&CODE=01&q=${encodeURIComponent(hebrewTitle)}`;
  const searchHtml = await fetchPageHtml(searchUrl, true);
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

  console.log("[שלב 2 - TVNetil HTML] נכנס לדף להעתיק כותרת:", tvnetilPageUrl);
  const pageHtml = await fetchPageHtml(tvnetilPageUrl, true);
  const $page = cheerio.load(pageHtml);

  const rawTitle =
    $page("h1.entry-title").text() ||
    $page(".review-header h1").text() ||
    $page(".title-review").text() ||
    $page("h1").first().text() ||
    "";

  const exactTitleFromTvnetil = cleanTvnetilHeaderTitle(rawTitle);

  if (!exactTitleFromTvnetil) {
    throw new Error("שלב 2 נכשל: לא ניתן היה לחלץ כותרת מתוך דף ה-TVNetil");
  }

  console.log("[שלב 2 - כותרת מלאה מ-TVNetil]:", exactTitleFromTvnetil);
  return { tvnetilPageUrl, exactTitleFromTvnetil };
}

/* =========================================================
   שלב 3: חיפוש ב-Favez0ne בפורמט "שם (שנה)"
========================================================= */

async function searchFavez0ne(exactTitleFromTvnetil) {
  const faveSearchTerm = formatTitleForFavez0ne(exactTitleFromTvnetil);
  
  console.log("[שלב 3 - Favez0ne] מדביק בחיפוש Favez0ne:", faveSearchTerm);

  const faveSearchUrl = `https://favez0ne.net/?s=${encodeURIComponent(faveSearchTerm)}`;
  const html = await fetchPageHtml(faveSearchUrl, false);
  const $ = cheerio.load(html);

  let favePostUrl = "";

  $("a[href*='favez0ne.net']").each((_, el) => {
    const href = $(el).attr("href");
    if (href && href.includes("/20") && !favePostUrl && !href.includes("?s=")) {
      favePostUrl = href;
    }
  });

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
  const html = await fetchPageHtml(faveUrl, false);
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
    // 1+2. איתור דף TVNetil והעתקת הכותרת המלאה מהדף
    const { tvnetilPageUrl, exactTitleFromTvnetil } = await getTvnetilDetails(hebrewTitle);

    // 3. חיפוש ב-Favez0ne בפורמט "שם (שנה)"
    const { favePostUrl, faveSearchTerm } = await searchFavez0ne(exactTitleFromTvnetil);

    // 4. משיכת הקישורים הישירים מ-Favez0ne
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
app.get("/", (_, res) => res.send("TVNetil Direct Streams 10.6.0"));

app.listen(process.env.PORT || 3000);
export default app;
