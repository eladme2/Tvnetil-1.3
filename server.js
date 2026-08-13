import express from "express";
import * as cheerio from "cheerio";

const app = express();

const SERPER_API_KEY = (process.env.SERPER_API_KEY || "").trim();
const SCRAPER_API_KEY = (process.env.SCRAPER_API_KEY || "").trim();

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "7.3.0",
  name: "TVNetil Direct Streams",
  description: "Native TextDecoder Hebrew Fix -> Fave -> Direct Streams",
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
    .replace(/\b(1080p|720p|WEB-DL|WEBRip|HD|DVDRip|XviD|AAC|HEVC|x264|x265)\b/gi, "")
    .trim();
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
   שלב 1+2: פנייה ישירה ל-TVNetil + פענוח עברית טבעי
========================================================= */

async function searchAndExtractTVNetilTitle(hebrewTitle) {
  console.log("[שלב 1] פנייה ישירה ל-TVNetil דרך ScraperAPI עבור:", hebrewTitle);

  if (!SCRAPER_API_KEY) {
    throw new Error("SCRAPER_API_KEY is missing in environment variables");
  }

  const tvnetilSearchUrl = `https://www.tvnetil.net/index.php?act=search&CODE=01&q=${encodeURIComponent(hebrewTitle)}`;
  const scraperUrl = `https://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(tvnetilSearchUrl)}`;

  const response = await fetch(scraperUrl);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ScraperAPI HTTP ${response.status}: ${errText.substring(0, 300)}`);
  }

  // פענוח עברית מובנה בעזרת TextDecoder Native
  const arrayBuffer = await response.arrayBuffer();
  let html = "";
  
  try {
    const win1255Decoder = new TextDecoder("windows-1255");
    html = win1255Decoder.decode(arrayBuffer);
  } catch {
    const utf8Decoder = new TextDecoder("utf-8");
    html = utf8Decoder.decode(arrayBuffer);
  }

  const $ = cheerio.load(html);

  let exactTitle =
    $("h1.entry-title").text() ||
    $(".review-header h1").text() ||
    $(".title-review").text() ||
    $(".search-result a").first().text() ||
    $("a[href*='/review/']").first().text() ||
    $("h1").first().text() ||
    $("title").text() ||
    "";

  exactTitle = cleanTVNetilTitle(exactTitle);

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
app.get("/", (_, res) => res.send("TVNetil Direct Streams 7.3.0"));

app.listen(process.env.PORT || 3000);
export default app;
