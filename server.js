import express from "express";
import * as cheerio from "cheerio";

const app = express();

const SERPER_API_KEY = (process.env.SERPER_API_KEY || "").trim();
const SCRAPER_API_KEY = (process.env.SCRAPER_API_KEY || "").trim();

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "8.4.0",
  name: "TVNetil Direct Streams",
  description: "Strict 4-Step Pipeline: Nuvio -> Serper (TVNetil Page) -> Scrape Page Title -> Serper (Fave) -> Streams",
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

  // מנקים רק שמות אתר/סיומות היקפיות, אך שומרים על הכותרת המלאה (כולל שנה, מדובב, שפה וכו')
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
   שלב 3: כניסה ל-URL של TVNetil וחילוץ הכותרת מתוך הדף עצמו
========================================================= */

async function fetchTvnetilPageHtml(tvnetilUrl) {
  if (!SCRAPER_API_KEY) {
    throw new Error("SCRAPER_API_KEY is missing");
  }

  const scraperUrl = `https://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(tvnetilUrl)}&binary=true`;
  const response = await fetch(scraperUrl);

  if (!response.ok) {
    throw new Error(`ScraperAPI Error HTTP ${response.status}`);
  }

  const buffer = await response.arrayBuffer();

  // פענוח קידוד Windows-1255 של TVNetil לעברית תקינה
  let html = new TextDecoder("windows-1255").decode(buffer);
  if (!/[\u0590-\u05FF]/.test(html)) {
    html = new TextDecoder("utf-8").decode(buffer);
  }

  return html;
}

async function extractTitleDirectlyFromTvnetilPage(tvnetilUrl) {
  console.log("[שלב 3 - Scraper] נכנס ל-URL המדויק מ-TVNetil:", tvnetilUrl);
  
  const html = await fetchTvnetilPageHtml(tvnetilUrl);
  const $ = cheerio.load(html);

  // שליפת הכותרת מתוך התגיות בדף עצמו
  const rawTitle =
    $("h1.entry-title").text() ||
    $(".review-header h1").text() ||
    $(".title-review").text() ||
    $("h1").first().text() ||
    $("title").text() ||
    "";

  const exactTitle = cleanTvnetilHeaderTitle(rawTitle);

  if (!exactTitle) {
    throw new Error("לא ניתן היה לחלץ כותרת מתוך דף ה-TVNetil");
  }

  console.log("[שלב 3 - תוצאה] הכותרת המדויקת שנשלפה מהדף בעברית:", exactTitle);
  return exactTitle;
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

async function scrapeFaveStreams(faveUrl, exactTitle) {
  console.log("[חילוץ סטרימים] סורק את עמוד ה-Fave:", faveUrl);
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
   MAIN PIPELINE (STRICT 4-STEP LOGIC)
========================================================= */

async function resolveTVNetilPipeline(nuvioTitle) {
  // -------------------------------------------------------
  // שלב 1 – Nuvio נותן לנו את הכותרת בעברית (nuvioTitle)
  // -------------------------------------------------------
  console.log("[שלב 1 - Nuvio] התקבלה כותרת מ-Nuvio:", nuvioTitle);

  // -------------------------------------------------------
  // שלב 2 – Serper ראשון: מציאת URL של דף הסרט ב-TVNetil
  // -------------------------------------------------------
  console.log("[שלב 2 - Serper 1] מחפש דף סרט מתאים ב-TVNetil עבור:", nuvioTitle);
  const tvnetilSearchData = await serperSearch(`site:tvnetil.net/review/ "${nuvioTitle}"`, 10);
  let organicTvnetil = Array.isArray(tvnetilSearchData?.organic) ? tvnetilSearchData.organic : [];

  if (!organicTvnetil.length) {
    const fallbackSearch = await serperSearch(`site:tvnetil.net "${nuvioTitle}"`, 10);
    organicTvnetil = Array.isArray(fallbackSearch?.organic) ? fallbackSearch.organic : [];
  }

  if (!organicTvnetil.length || !organicTvnetil[0].link) {
    return {
      success: false,
      step: "step-2-tvnetil-page-not-found",
      message: "לא נמצא דף סרט מתאים ב-TVNetil",
      nuvioTitle,
      streams: []
    };
  }

  const selectedTvnetilLink = organicTvnetil[0].link;
  console.log("[שלב 2 - תוצאה] נמצא URL של TVNetil:", selectedTvnetilLink);

  // -------------------------------------------------------
  // שלב 3 – Scraper: כניסה לדף TVNetil וחילוץ הכותרת המדויקת
  // -------------------------------------------------------
  let exactTitleFromPage = "";
  try {
    exactTitleFromPage = await extractTitleDirectlyFromTvnetilPage(selectedTvnetilLink);
  } catch (err) {
    return {
      success: false,
      step: "step-3-scraper-failed",
      error: err.message,
      selectedTvnetilLink,
      streams: []
    };
  }

  // -------------------------------------------------------
  // שלב 4 – Serper שני: חיפוש תוצאת הצפייה לפי הכותרת המדויקת
  // -------------------------------------------------------
  console.log("[שלב 4 - Serper 2] מחפש תוצאת צפייה ב-Favez0ne עבור הכותרת המדויקת:", exactTitleFromPage);
  
  const faveSearchData = await serperSearch(`site:favez0ne.net "${exactTitleFromPage}"`, 10);
  let organicFave = Array.isArray(faveSearchData?.organic) ? faveSearchData.organic : [];

  if (!organicFave.length) {
    // במידה וחיפוש עם מרכאות מדויקות לא החזיר תוצאה (למשל עקב מרווח בודד), מנסים חיפוש גמיש יותר
    const fallbackFave = await serperSearch(`site:favez0ne.net ${exactTitleFromPage}`, 10);
    organicFave = Array.isArray(fallbackFave?.organic) ? fallbackFave.organic : [];
  }

  if (!organicFave.length || !organicFave[0].link) {
    return {
      success: false,
      step: "step-4-fave-page-not-found",
      nuvioTitle,
      selectedTvnetilLink,
      exactTitleFromPage,
      streams: []
    };
  }

  const faveUrl = organicFave[0].link;
  const streams = await scrapeFaveStreams(faveUrl, exactTitleFromPage);

  return {
    success: streams.length > 0,
    pipeline: {
      step1_nuvioTitle: nuvioTitle,
      step2_tvnetilUrl: selectedTvnetilLink,
      step3_exactTitleFromPage: exactTitleFromPage,
      step4_faveUrl: faveUrl
    },
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
    return res.json(await resolveTVNetilPipeline(title));
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, streams: [] });
  }
});

app.get("/manifest.json", (_, res) => res.json(MANIFEST));
app.get("/", (_, res) => res.send("TVNetil Direct Streams 8.4.0"));

app.listen(process.env.PORT || 3000);
export default app;
