import express from "express";
import * as cheerio from "cheerio";

const app = express();

const SERPER_API_KEY = (process.env.SERPER_API_KEY || "").trim();
const SCRAPER_API_KEY = (process.env.SCRAPER_API_KEY || "").trim();

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "7.7.0",
  name: "TVNetil Direct Streams",
  description: "Exact Title Scraping via ScraperAPI UTF8 -> Fave -> Streams",
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

function cleanTvnetilExactTitle(rawTitle) {
  if (!rawTitle) return "";
  let title = decodeHtmlEntities(rawTitle).trim();
  
  // ניקוי סיומות אתר סטנדרטיות אם קיימות בכותרת הדף
  title = title
    .replace(/\s*[-|–—]\s*TVNetil.*$/iu, "")
    .replace(/^TVNetil\.net\s*[-|:]\s*/iu, "")
    .replace(/\s*[-|–—]\s*סרטים.*$/iu, "")
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
   שלב 1: משיכת עמוד הסרט מ-TVNetil 
========================================================= */

async function fetchTvnetilHtml(targetUrl) {
  const scraperUrl = `https://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}`;
  const response = await fetch(scraperUrl);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ScraperAPI HTTP ${response.status}: ${errText.substring(0, 300)}`);
  }

  return await response.text();
}

async function getExactTitleFromTvnetilPage(hebrewTitle) {
  console.log("[שלב 1] מחפש את עמוד הסרט ב-TVNetil עבור:", hebrewTitle);

  if (!SCRAPER_API_KEY) {
    throw new Error("SCRAPER_API_KEY is missing in environment variables");
  }

  // 1. פנייה לדף החיפוש ב-TVNetil
  const tvnetilSearchUrl = `https://www.tvnetil.net/index.php?act=search&CODE=01&q=${encodeURIComponent(hebrewTitle)}`;
  const searchHtml = await fetchTvnetilHtml(tvnetilSearchUrl);
  const $search = cheerio.load(searchHtml);

  // 2. איתור הקישור הישיר לעמוד הסרט/הסיקור (/review/)
  let reviewUrl = "";
  $search("a[href*='/review/']").each((_, el) => {
    const href = $search(el).attr("href");
    if (href && !reviewUrl) {
      reviewUrl = href.startsWith("http") ? href : `https://www.tvnetil.net${href.startsWith("/") ? "" : "/"}${href}`;
    }
  });

  let rawExtractedTitle = "";

  // 3. כניסה לעמוד הסרט המקורי והעתקת הכותרת המדויקת
  if (reviewUrl) {
    console.log("[שלב 1.5] נכנס לעמוד הסרט המקורי ב-TVNetil:", reviewUrl);
    const moviePageHtml = await fetchTvnetilHtml(reviewUrl);
    const $movie = cheerio.load(moviePageHtml);

    rawExtractedTitle =
      $movie("h1.entry-title").text() ||
      $movie(".review-header h1").text() ||
      $movie(".title-review").text() ||
      $movie("h1").first().text() ||
      $movie("title").text() ||
      "";
  } else {
    rawExtractedTitle = $search("a[href*='/review/']").first().text() || "";
  }

  const exactTitle = cleanTvnetilExactTitle(rawExtractedTitle);

  if (!exactTitle) {
    throw new Error("לא ניתן היה להוציא את כותרת הסרט המקורית מעמוד ה-TVNetil");
  }

  console.log("[שלב 2] הכותרת המקורית שהועתקה מעמוד הסרט:", exactTitle);
  return { exactTitle, tvnetilSearchUrl, reviewUrl };
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
  let reviewUrl = "";

  try {
    const scraped = await getExactTitleFromTvnetilPage(hebrewTitle);
    exactTitle = scraped.exactTitle;
    tvnetilSearchUrl = scraped.tvnetilSearchUrl;
    reviewUrl = scraped.reviewUrl;
  } catch (err) {
    return {
      success: false,
      step: "tvnetil-scrape-failed",
      error: err.message,
      streams: []
    };
  }

  console.log("[שלב 3] מחפש ב-Favez0ne עבור הכותרת המקורית:", exactTitle);
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
      reviewUrl,
      exactTitle,
      streams: []
    };
  }

  const faveUrl = organic[0].link;
  const streams = await scrapeFaveToNuvioStreams(faveUrl, exactTitle);

  return {
    success: streams.length > 0,
    hebrewTitle,
    tvnetilSearchUrl,
    reviewUrl,
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
app.get("/", (_, res) => res.send("TVNetil Direct Streams 7.7.0"));

app.listen(process.env.PORT || 3000);
export default app;
