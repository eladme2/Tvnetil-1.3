import express from "express";
import * as cheerio from "cheerio";

const app = express();

const SERPER_API_KEY = process.env.SERPER_API_KEY;

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "4.3.0",
  name: "TVNetil Direct Streams",
  description: "Nuvio -> Serper 1 -> Scrape TVNetil HTML Title -> Serper 2 (Fave) -> Scrape Fave Page -> Streams",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"]
};

/* =========================================================
   TEXT & HTML UTILS
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

function hasHebrew(value) {
  return /[\u0590-\u05FF]/u.test(String(value || ""));
}

/* =========================================================
   STEP 2: SCRAPE HTML FROM TVNETIL PAGE (ACTIVE SCRAPER)
========================================================= */

async function scrapeTVNetilTitleFromUrl(pageUrl) {
  console.log("FETCHING AND SCRAPING TVNETIL PAGE HTML:", pageUrl);
  
  // הפיכה ל-HTTPS במידת הצורך
  const secureUrl = pageUrl.replace(/^http:/i, "https:");

  const response = await fetch(secureUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch TVNetil HTML page: HTTP ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  // חילוץ הכותרת מתוך אלמנט ה-HTML של הדף
  let extractedTitle =
    $("h1.entry-title").text() ||
    $(".review-header h1").text() ||
    $(".title-review").text() ||
    $("h1").first().text() ||
    $("title").text() ||
    "";

  extractedTitle = cleanTVNetilTitle(extractedTitle);

  if (!extractedTitle) {
    throw new Error("Could not extract movie title from TVNetil HTML");
  }

  console.log("EXTRACTED TITLE FROM TVNETIL HTML:", extractedTitle);
  return extractedTitle;
}

/* =========================================================
   URL EXTRACTION & PARSING
========================================================= */

function extractUrlsFromText(text) {
  const value = String(text || "");
  const urls = value.match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  return urls.map(url => url.replace(/[.,;!?]+$/g, "").trim());
}

function normalizePixelDrainUrl(url) {
  let value = String(url || "").trim().replace(/[.,;!?]+$/g, "");
  if (!value) return null;

  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes("pixeldrain.com")) return null;

    const apiMatch = parsed.pathname.match(/^\/api\/file\/([A-Za-z0-9_-]+)\/?$/i);
    if (apiMatch) return { url: `https://pixeldrain.com/api/file/${apiMatch[1]}`, id: apiMatch[1] };

    const userMatch = parsed.pathname.match(/^\/u\/([A-Za-z0-9_-]+)\/?$/i);
    if (userMatch) return { url: `https://pixeldrain.com/api/file/${userMatch[1]}`, id: userMatch[1] };
    
    const fileMatch = parsed.pathname.match(/^\/l\/([A-Za-z0-9_-]+)\/?$/i);
    if (fileMatch) return { url: `https://pixeldrain.com/u/${fileMatch[1]}`, id: fileMatch[1] };
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
    if (match) return { url: `https://gofile.io/d/${match[1]}`, id: match[1] };
  } catch {
    return null;
  }
  return null;
}

/* =========================================================
   STEP 4: SCRAPE FAVE PAGE FOR DIRECT LINKS
========================================================= */

async function scrapeFavePageForLinks(faveUrl) {
  console.log("SCRAPING FAVE PAGE FOR DIRECT STREAMS:", faveUrl);
  const streams = [];

  try {
    const response = await fetch(faveUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
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

    const allTextUrls = extractUrlsFromText(html);
    const combinedUrls = Array.from(new Set([...pageUrls, ...allTextUrls]));

    for (const rawUrl of combinedUrls) {
      const pixel = normalizePixelDrainUrl(rawUrl);
      if (pixel) {
        streams.push({
          name: "PixelDrain (Fave)",
          title: "PixelDrain Direct Stream",
          url: pixel.url,
          type: "http"
        });
      }

      const gofile = normalizeGoFileUrl(rawUrl);
      if (gofile) {
        streams.push({
          name: "GoFile (Fave)",
          title: "GoFile Direct Stream",
          url: gofile.url,
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
   SERPER SEARCH UTIL
========================================================= */

async function serperSearch(query, num = 20) {
  if (!SERPER_API_KEY) {
    throw new Error("SERPER_API_KEY is missing");
  }

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
   COMPLETE FLOW
========================================================= */

async function resolveTVNetil(hebrewTitle) {
  // 1. Serper ראשון: מציאת ה-URL של TVNetil
  const firstData = await serperSearch(`${hebrewTitle} TVNetil`, 20);
  const organic1 = Array.isArray(firstData?.organic) ? firstData.organic : [];

  const tvnetilItem = organic1.find(item =>
    String(item.link || "").toLowerCase().includes("tvnetil.net/review/")
  );

  if (!tvnetilItem || !tvnetilItem.link) {
    return { success: false, step: "tvnetil-url-not-found", streams: [] };
  }

  const tvnetilUrl = tvnetilItem.link;

  // 2. פתיחת ה-URL באמצעות Scraper וחילוץ כותרת הסרט מתוך ה-HTML
  let tvnetilHtmlTitle = "";
  try {
    tvnetilHtmlTitle = await scrapeTVNetilTitleFromUrl(tvnetilUrl);
  } catch (scrapeErr) {
    console.error("Scraper Error:", scrapeErr.message);
    return {
      success: false,
      step: "tvnetil-html-scrape-failed",
      tvnetilUrl,
      error: scrapeErr.message,
      streams: []
    };
  }

  // 3. Serper שני: החיפוש מתבצע אך ורק עם הכותרת שחולצה מתוך ה-HTML של TVNetil
  const faveSearchQuery = `site:favez0ne.net "${tvnetilHtmlTitle}"`;
  console.log("RUNNING SECOND SERPER SEARCH WITH HTML TITLE:", faveSearchQuery);

  const faveData = await serperSearch(faveSearchQuery, 20);
  let organic2 = Array.isArray(faveData?.organic) ? faveData.organic : [];

  // fallback במידה והחיפוש הראשי עם מרכאות כפולות קשיחות לא מחזיר תוצאות
  if (!organic2.length) {
    const fallbackQuery = `site:favez0ne.net ${tvnetilHtmlTitle}`;
    const fallbackFave = await serperSearch(fallbackQuery, 20);
    organic2 = Array.isArray(fallbackFave?.organic) ? fallbackFave.organic : [];
  }

  if (!organic2.length || !organic2[0].link) {
    return {
      success: false,
      step: "fave-page-not-found",
      tvnetilUrl,
      tvnetilHtmlTitle,
      faveQueryUsed: faveSearchQuery,
      streams: []
    };
  }

  const favePageUrl = organic2[0].link;

  // 4. סריקת עמוד ה-Fave והוצאת ה-Streams
  const streams = await scrapeFavePageForLinks(favePageUrl);

  return {
    success: streams.length > 0,
    hebrewTitle,
    tvnetilUrl,
    tvnetilHtmlTitle, // הכותרת מתוך ה-HTML
    favePageUrl,
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
app.get("/", (_, res) => res.send("TVNetil Direct Streams 4.3.0"));

app.listen(process.env.PORT || 3000);
export default app;
