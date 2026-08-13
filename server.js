import express from "express";
import * as cheerio from "cheerio";

const app = express();

const SERPER_API_KEY = process.env.SERPER_API_KEY;

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "4.5.0",
  name: "TVNetil Direct Streams",
  description: "Nuvio -> Serper 1 -> Scraper TVNetil -> Serper 2 -> Scraper Fave -> Nuvio Streams",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"]
};

/* =========================================================
   UTILITIES & CLEANING
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
   STEP 2: SCRAPER - TVNETIL HTML TITLE
========================================================= */

async function scrapeTVNetilTitle(pageUrl) {
  console.log("SCRAPING TVNETIL PAGE:", pageUrl);
  const secureUrl = pageUrl.replace(/^http:/i, "https:");

  const response = await fetch(secureUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    }
  });

  if (!response.ok) {
    throw new Error(`TVNetil Scrape HTTP ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  let exactTitle =
    $("h1.entry-title").text() ||
    $(".review-header h1").text() ||
    $(".title-review").text() ||
    $("h1").first().text() ||
    $("title").text() ||
    "";

  exactTitle = cleanTVNetilTitle(exactTitle);

  if (!exactTitle) {
    throw new Error("Could not extract title from TVNetil HTML");
  }

  return exactTitle;
}

/* =========================================================
   STEP 4: SCRAPER & NUVIO STREAM FORMATTING (תיקון התוצאות)
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

async function scrapeFaveToNuvioStreams(faveUrl, movieTitle) {
  console.log("SCRAPING FAVE PAGE FOR STREAMS:", faveUrl);
  const streams = [];
  const seenUrls = new Set();

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

    const combinedUrls = Array.from(new Set([...pageUrls, ...extractUrlsFromText(html)]));

    for (const rawUrl of combinedUrls) {
      // 1. חילוץ PixelDrain
      const pixelUrl = normalizePixelDrainUrl(rawUrl);
      if (pixelUrl && !seenUrls.has(pixelUrl)) {
        seenUrls.add(pixelUrl);
        streams.push({
          name: "TVNetil",
          title: `⚡ PixelDrain | ${movieTitle}`,
          url: pixelUrl,
          type: "http"
        });
      }

      // 2. חילוץ GoFile
      const gofileUrl = normalizeGoFileUrl(rawUrl);
      if (gofileUrl && !seenUrls.has(gofileUrl)) {
        seenUrls.add(gofileUrl);
        streams.push({
          name: "TVNetil",
          title: `🚀 GoFile | ${movieTitle}`,
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
   COMPLETE FLOW
========================================================= */

async function resolveTVNetil(hebrewTitle) {
  // 1. Serper ראשון: מציאת דף TVNetil
  const firstData = await serperSearch(`${hebrewTitle} TVNetil`, 20);
  const organic1 = Array.isArray(firstData?.organic) ? firstData.organic : [];

  const tvnetilItem = organic1.find(item =>
    String(item.link || "").toLowerCase().includes("tvnetil.net/review/")
  );

  if (!tvnetilItem || !tvnetilItem.link) {
    return { success: false, step: "tvnetil-url-not-found", streams: [] };
  }

  // 2. Scraper: פתיחת ה-URL וחילוץ ה-HTML Title המדויק
  let exactHtmlTitle = "";
  try {
    exactHtmlTitle = await scrapeTVNetilTitle(tvnetilItem.link);
  } catch (err) {
    return {
      success: false,
      step: "tvnetil-scraper-failed",
      tvnetilUrl: tvnetilItem.link,
      error: err.message,
      streams: []
    };
  }

  // 3. Serper שני: חיפוש ב-Favez0ne עם הכותרת המדויקת שחולצה מה-HTML
  const faveData = await serperSearch(`site:favez0ne.net "${exactHtmlTitle}"`, 20);
  let organic2 = Array.isArray(faveData?.organic) ? faveData.organic : [];

  if (!organic2.length) {
    const fallbackFave = await serperSearch(`site:favez0ne.net ${exactHtmlTitle}`, 20);
    organic2 = Array.isArray(fallbackFave?.organic) ? fallbackFave.organic : [];
  }

  if (!organic2.length || !organic2[0].link) {
    return {
      success: false,
      step: "fave-page-not-found",
      tvnetilUrl: tvnetilItem.link,
      exactHtmlTitle,
      streams: []
    };
  }

  const faveUrl = organic2[0].link;

  // 4. Scraper Fave & Streams Conversion (הפיכה לפורמט Nuvio)
  const streams = await scrapeFaveToNuvioStreams(faveUrl, exactHtmlTitle);

  return {
    success: streams.length > 0,
    hebrewTitle,
    tvnetilUrl: tvnetilItem.link,
    exactHtmlTitle,
    faveUrl,
    streams
  };
}

/* =========================================================
   ROUTES & NUVIO ENDPOINTS
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

app.get("/stream/:type/:id.json", async (req, res) => {
  const { id } = req.params;
  // Endpoint ייעודי ש-Nuvio פונה אליו ישירות לקבלת ה-Streams
  try {
    const result = await resolveTVNetil(id);
    return res.json({ streams: result.streams || [] });
  } catch {
    return res.json({ streams: [] });
  }
});

app.get("/manifest.json", (_, res) => res.json(MANIFEST));
app.get("/", (_, res) => res.send("TVNetil Direct Streams 4.5.0"));

app.listen(process.env.PORT || 3000);
export default app;
