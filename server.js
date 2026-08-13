import express from "express";
import * as cheerio from "cheerio";

const app = express();

const SERPER_API_KEY = (process.env.SERPER_API_KEY || "").trim();
const SCRAPER_API_KEY = (process.env.SCRAPER_API_KEY || "").trim();

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "9.1.0",
  name: "TVNetil Direct Streams",
  description: "Strict Flow using Serper for Anti-Blocking & TVNetil Scraper Title Extraction",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"]
};

/* =========================================================
   UTILS & ENCODING
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

function cleanTvnetilHeaderTitle(rawTitle) {
  if (!rawTitle) return "";
  let title = decodeHtmlEntities(rawTitle).trim();

  // הסרת סיומות אתר בלבד
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
   SERPER API (עוקף חסימות לחיפוש כתובות)
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
   SCRAPER API (עוקף חסימות לטעינת דף HTML מלא)
========================================================= */

async function fetchTvnetilPageHtml(tvnetilUrl) {
  if (!SCRAPER_API_KEY) throw new Error("SCRAPER_API_KEY is missing");

  const scraperUrl = `https://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(tvnetilUrl)}&binary=true`;
  const response = await fetch(scraperUrl);

  if (!response.ok) throw new Error(`ScraperAPI HTTP ${response.status}`);

  const buffer = await response.arrayBuffer();
  let html = new TextDecoder("windows-1255").decode(buffer);
  if (!/[\u0590-\u05FF]/.test(html)) {
    html = new TextDecoder("utf-8").decode(buffer);
  }
  return html;
}

/* =========================================================
   MAIN PIPELINE
========================================================= */

async function resolveTVNetilPipeline(nuvioTitle) {
  // שלב 1: Nuvio Title
  console.log("[שלב 1] שם מ-Nuvio:", nuvioTitle);

  // שלב 2: מציאת עמוד TVNetil דרך Serper
  console.log("[שלב 2] מוצא עמוד TVNetil דרך Serper עבור:", nuvioTitle);
  const tvnetilSearch = await serperSearch(`site:tvnetil.net/review/ "${nuvioTitle}"`, 10);
  let organicTvnetil = Array.isArray(tvnetilSearch?.organic) ? tvnetilSearch.organic : [];

  if (!organicTvnetil.length) {
    const fallbackSearch = await serperSearch(`site:tvnetil.net "${nuvioTitle}"`, 10);
    organicTvnetil = Array.isArray(fallbackSearch?.organic) ? fallbackSearch.organic : [];
  }

  if (!organicTvnetil.length || !organicTvnetil[0].link) {
    return { success: false, step: "tvnetil-page-not-found", nuvioTitle, streams: [] };
  }

  const tvnetilUrl = organicTvnetil[0].link;

  // שלב 3: כניסה לעמוד TVNetil עם ScraperAPI והעתקת הכותרת מה-HTML
  console.log("[שלב 3] נכנס ל-HTML של TVNetil כדי להעתיק כותרת מדויקת:", tvnetilUrl);
  let exactTitleFromTvnetil = "";
  try {
    const html = await fetchTvnetilPageHtml(tvnetilUrl);
    const $ = cheerio.load(html);
    const rawTitle =
      $("h1.entry-title").text() ||
      $(".review-header h1").text() ||
      $(".title-review").text() ||
      $("h1").first().text() ||
      "";

    exactTitleFromTvnetil = cleanTvnetilHeaderTitle(rawTitle);
  } catch (err) {
    return { success: false, step: "scraper-failed", error: err.message, tvnetilUrl, streams: [] };
  }

  console.log("[שלב 3 - תוצאה] הכותרת שהועתקה מעמוד הסרט:", exactTitleFromTvnetil);

  // שלב 4: הדבקת הכותרת שהועתקה ל-Serper בחיפוש ממוקד ב-Favez0ne
  // מנקים סיומות כמו "- מדובב" למקרה שב-Favez0ne רשמו רק "שם בעברית / שם באנגלית (שנה)"
  const cleanTitleForFave = exactTitleFromTvnetil.replace(/\s*[-|–—:]\s*(מדובב|מתורגם|תרגום מובנה).*$/iu, "").trim();

  console.log("[שלב 4] מדביק ב-Serper לחיפוש ב-Favez0ne:", cleanTitleForFave);

  const queriesToTry = [
    `site:favez0ne.net "${cleanTitleForFave}"`,
    `site:favez0ne.net ${cleanTitleForFave}`,
    `site:favez0ne.net "${exactTitleFromTvnetil}"`,
    `site:favez0ne.net ${nuvioTitle}`
  ];

  let organicFave = [];
  let usedQuery = "";

  for (const q of queriesToTry) {
    const faveSearch = await serperSearch(q, 10);
    const results = Array.isArray(faveSearch?.organic) ? faveSearch.organic : [];
    if (results.length > 0 && results[0].link) {
      organicFave = results;
      usedQuery = q;
      break;
    }
  }

  if (!organicFave.length || !organicFave[0].link) {
    return {
      success: false,
      step: "fave-page-not-found",
      tvnetilUrl,
      exactTitleFromTvnetil,
      cleanTitleForFave,
      queriesAttempted: queriesToTry,
      streams: []
    };
  }

  const faveUrl = organicFave[0].link;

  // שלב 5: חילוץ סטרימים מהעמוד ב-Favez0ne
  const streams = await scrapeFaveStreams(faveUrl, exactTitleFromTvnetil);

  return {
    success: streams.length > 0,
    pipeline: {
      nuvioTitle,
      tvnetilUrl,
      exactTitleFromTvnetil,
      cleanTitleForFave,
      faveUrl,
      usedQuery
    },
    streams
  };
}

/* =========================================================
   STREAM PARSING FOR FAVE
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

async function scrapeFaveStreams(faveUrl, exactTitle) {
  const streams = [];
  const seenUrls = new Set();

  try {
    const response = await fetch(faveUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36" }
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
   ROUTES
========================================================= */

app.get("/test-title", async (req, res) => {
  const title = String(req.query.q || "").trim();
  if (!title) return res.json({ success: false, message: "Use ?q=שם" });

  try {
    return res.json(await resolveTVNetilPipeline(title));
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, streams: [] });
  }
});

app.get("/manifest.json", (_, res) => res.json(MANIFEST));
app.get("/", (_, res) => res.send("TVNetil Direct Streams 9.1.0"));

app.listen(process.env.PORT || 3000);
export default app;
