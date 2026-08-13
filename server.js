import express from "express";
import * as cheerio from "cheerio";

const app = express();

const SERPER_API_KEY = process.env.SERPER_API_KEY;

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "4.0.0",
  name: "TVNetil Direct Streams",
  description:
    "Nuvio Hebrew title -> Serper -> TVNetil -> Web Scraper -> Exact Page Title -> Serper 2 (Fave only) -> Nuvio",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"]
};

/* =========================================================
   HTTP HELPERS
========================================================= */

async function getJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/json,text/plain,*/*",
      "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON response: ${text.slice(0, 500)}`);
  }
}

/* =========================================================
   TEXT UTILS
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

function normalize(value) {
  return cleanText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function hasHebrew(value) {
  return /[\u0590-\u05FF]/u.test(String(value || ""));
}

/* =========================================================
   STEP 2 (SCRAPER): FETCH EXACT TITLE FROM TVNETIL PAGE
========================================================= */

async function fetchTVNetilPageTitle(pageUrl) {
  console.log("======================================");
  console.log("SCRAPING TVNETIL PAGE:", pageUrl);

  const response = await fetch(pageUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to scrape TVNetil page. Status: ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  // חילוץ הכותרת מתוך אלמנט הכותרת בדף (H1 או Title)
  let extractedTitle =
    $("h1.entry-title").text() ||
    $(".review-header h1").text() ||
    $("h1").first().text() ||
    $("title").text() ||
    "";

  extractedTitle = cleanText(extractedTitle);

  // הסרת סיומות ושם האתר מהכותרת
  extractedTitle = extractedTitle
    .replace(/\s*[-|–—]\s*TVNetil.*$/iu, "")
    .replace(/^TVNetil\.net\s*[-|:]\s*/iu, "")
    .trim();

  console.log("EXTRACTED EXACT TVNETIL TITLE:", extractedTitle);
  return extractedTitle || null;
}

/* =========================================================
   SERPER API
========================================================= */

async function serperSearch(query, num = 20) {
  if (!SERPER_API_KEY) {
    throw new Error("SERPER_API_KEY is missing");
  }

  console.log("======================================");
  console.log("SERPER QUERY:", query);

  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": SERPER_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      q: query,
      gl: "il",
      hl: "he",
      num
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`SERPER HTTP ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

/* =========================================================
   CINEMETA METADATA
========================================================= */

async function getMetadata(type, imdbId) {
  const url = `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(imdbId)}.json`;
  const data = await getJson(url);
  return data?.meta || data || null;
}

function getHebrewTitle(req, metadata) {
  const requestTitle = String(req.query.title || "").trim();

  if (requestTitle) {
    if (!hasHebrew(requestTitle)) {
      return null;
    }
    return cleanText(requestTitle);
  }

  const metadataTitle = cleanText(metadata?.name || metadata?.title || "");

  if (metadataTitle && hasHebrew(metadataTitle)) {
    return metadataTitle;
  }

  return null;
}

/* =========================================================
   STEP 1: SERPER FIRST SEARCH (Nuvio Title -> TVNetil Link)
========================================================= */

async function searchTVNetil(hebrewTitle) {
  const query = `${hebrewTitle} TVNetil`;
  const data = await serperSearch(query, 20);

  const organic = Array.isArray(data?.organic) ? data.organic : [];

  const allResults = organic.map(item => ({
    title: item?.title || null,
    link: item?.link || null,
    snippet: item?.snippet || null,
    date: item?.date || null,
    position: item?.position || null
  }));

  const tvnetilResults = allResults.filter(item => {
    const link = String(item.link || "").toLowerCase();
    return link.includes("tvnetil.net/review/");
  });

  return {
    query,
    resultCount: tvnetilResults.length,
    results: tvnetilResults,
    allSearchResults: allResults
  };
}

function chooseTVNetilResult(results, hebrewTitle) {
  const wanted = normalize(hebrewTitle);
  const words = wanted.split(" ").filter(word => word.length >= 2);

  let best = null;
  let bestScore = -1;

  for (const item of results) {
    const text = normalize(`${item.title || ""} ${item.snippet || ""}`);
    let score = 0;

    if (text.includes(wanted)) {
      score += 500;
    }

    for (const word of words) {
      if (text.includes(word)) {
        score += 30;
      }
    }

    const link = String(item.link || "").toLowerCase();
    if (/\/review\/\d+\/\d+/.test(link)) {
      score += 300;
    }

    if (/מדובב/i.test(`${item.title || ""} ${item.snippet || ""}`)) {
      score += 100;
    }

    if (words.length > 0 && !words.some(word => text.includes(word))) {
      continue;
    }

    if (score > bestScore) {
      bestScore = score;
      best = { ...item, score };
    }
  }

  return best;
}

/* =========================================================
   STEP 3: SERPER SECOND SEARCH (Scraped TVNetil Title -> Fave ONLY)
========================================================= */

async function searchFave(tvnetilTitle) {
  if (!tvnetilTitle) {
    return {
      queries: [],
      resultCount: 0,
      results: []
    };
  }

  // חיפוש ממוקד ב-Fave בלבד לפי הכותרת המדויקת שנשלפה
  const queries = [
    `site:favez0ne.net "${tvnetilTitle}"`,
    `site:favez0ne.net ${tvnetilTitle}`,
    `site:favez0ne.net "${tvnetilTitle}" "pixeldrain"`,
    `site:favez0ne.net "${tvnetilTitle}" "gofile"`
  ];

  const collected = [];
  const seen = new Set();

  for (const query of queries) {
    try {
      const data = await serperSearch(query, 20);
      const organic = Array.isArray(data?.organic) ? data.organic : [];

      for (const item of organic) {
        const result = {
          title: item?.title || null,
          link: item?.link || null,
          snippet: item?.snippet || null,
          date: item?.date || null,
          position: item?.position || null,
          query
        };

        const link = String(result.link || "").trim().toLowerCase();

        // סינון קשיח - רק תוצאות מ-favez0ne.net
        if (!link.includes("favez0ne.net")) {
          continue;
        }

        if (seen.has(link)) {
          continue;
        }

        seen.add(link);
        collected.push(result);
      }
    } catch (error) {
      console.error("FAVE SEARCH ERROR:", error.message);
    }
  }

  return {
    queries,
    resultCount: collected.length,
    results: collected
  };
}

/* =========================================================
   URL EXTRACTION (PixelDrain / GoFile from Fave Results)
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
    if (host !== "pixeldrain.com" && host !== "www.pixeldrain.com") return null;
    if (parsed.pathname === "/" || parsed.pathname === "") return null;

    const apiMatch = parsed.pathname.match(/^\/api\/file\/([A-Za-z0-9_-]+)\/?$/i);
    if (apiMatch) return { url: `https://pixeldrain.com/api/file/${apiMatch[1]}`, id: apiMatch[1] };

    const userMatch = parsed.pathname.match(/^\/u\/([A-Za-z0-9_-]+)\/?$/i);
    if (userMatch) return { url: `https://pixeldrain.com/api/file/${userMatch[1]}`, id: userMatch[1] };
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
    if (host !== "gofile.io" && host !== "www.gofile.io") return null;

    const match = parsed.pathname.match(/^\/d\/([A-Za-z0-9_-]+)\/?$/i);
    if (match) return { url: `https://gofile.io/d/${match[1]}`, id: match[1] };
  } catch {
    return null;
  }
  return null;
}

function extractFaveStreams(faveSearch) {
  const streams = [];
  const seen = new Set();

  for (const result of faveSearch?.results || []) {
    const sourceText = [result.title, result.snippet, result.link].filter(Boolean).join(" ");
    const urls = extractUrlsFromText(sourceText);

    for (const rawUrl of urls) {
      const pixel = normalizePixelDrainUrl(rawUrl);
      if (pixel && !seen.has(pixel.url)) {
        seen.add(pixel.url);
        streams.push({
          name: "PixelDrain (Fave)",
          title: cleanText(result.title || "PixelDrain"),
          url: pixel.url,
          type: "http"
        });
        continue;
      }

      const gofile = normalizeGoFileUrl(rawUrl);
      if (gofile && !seen.has(gofile.url)) {
        seen.add(gofile.url);
        streams.push({
          name: "GoFile (Fave)",
          title: cleanText(result.title || "GoFile"),
          url: gofile.url,
          type: "http"
        });
      }
    }
  }

  return streams;
}

/* =========================================================
   COMPLETE EXACT FLOW Execution
========================================================= */

async function resolveTVNetil(hebrewTitle) {
  console.log("======================================");
  console.log("FLOW START: NUVIO HEBREW TITLE:", hebrewTitle);

  // 1. Serper 1: Nuvio -> TVNetil
  const firstSearch = await searchTVNetil(hebrewTitle);
  if (!firstSearch.results.length) {
    return { success: false, step: "tvnetil-search", hebrewTitle, firstSearch, streams: [] };
  }

  // בחירת תוצאת TVNetil המתאימה ביותר
  const selected = chooseTVNetilResult(firstSearch.results, hebrewTitle);
  if (!selected || !selected.link) {
    return { success: false, step: "tvnetil-selection", hebrewTitle, firstSearch, streams: [] };
  }

  // 2. Scraper: כניסה לדף TVNetil וחילוץ הכותרת מדף הסרט בלבד
  let tvnetilTitle = null;
  try {
    tvnetilTitle = await fetchTVNetilPageTitle(selected.link);
  } catch (error) {
    console.error("SCRAPER ERROR:", error.message);
  }

  if (!tvnetilTitle) {
    return {
      success: false,
      step: "tvnetil-scraping-failed",
      hebrewTitle,
      tvnetilResult: selected,
      streams: []
    };
  }

  console.log("EXACT TVNETIL TITLE FOR SECOND SERPER SEARCH:", tvnetilTitle);

  // 3. Serper 2: חיפוש ב-Fave בלבד לפי הכותרת המדויקת מה-Scraper
  const faveSearch = await searchFave(tvnetilTitle);
  console.log("FAVE RESULTS COUNT:", faveSearch.resultCount);

  // 4. חילוץ הלינקים שחזרו מ תוצאות Fave והחזרה ל-Nuvio
  const streams = extractFaveStreams(faveSearch);

  return {
    success: streams.length > 0,
    step: streams.length > 0 ? "streams" : "fave-results",
    hebrewTitle,
    firstSearch,
    tvnetilResult: selected,
    tvnetilTitle,
    faveSearch,
    streams
  };
}

/* =========================================================
   ROUTES
========================================================= */

app.get("/test-title", async (req, res) => {
  const title = String(req.query.q || "").trim();

  if (!title) {
    return res.json({ success: false, message: "Use ?q=שם הסרט בעברית" });
  }

  if (!hasHebrew(title)) {
    return res.json({
      success: false,
      step: "hebrew-title",
      inputTitle: title,
      message: "No Hebrew title provided. Search disabled.",
      streams: []
    });
  }

  try {
    return res.json(await resolveTVNetil(title));
  } catch (error) {
    console.error(error.stack || error.message);
    return res.status(500).json({
      success: false,
      error: error.message,
      streams: []
    });
  }
});

app.get("/stream/:type/:id.json", async (req, res) => {
  const id = String(req.params.id || "").trim();
  const type = req.params.type === "series" ? "series" : "movie";

  if (!id) {
    return res.json({ streams: [] });
  }

  let metadataTitle = null;

  try {
    const metadata = await getMetadata(type, id);
    metadataTitle = cleanText(metadata?.name || metadata?.title || "");

    const hebrewTitle = getHebrewTitle(req, metadata);

    if (!hebrewTitle) {
      return res.json({
        streams: [],
        tvnetil: {
          success: false,
          imdbId: id,
          metadataTitle,
          step: "hebrew-title",
          message: "No Hebrew title available."
        }
      });
    }

    const result = await resolveTVNetil(hebrewTitle);

    return res.json({
      streams: result.streams || [],
      tvnetil: {
        ...result,
        imdbId: id,
        metadataTitle
      }
    });
  } catch (error) {
    console.error(error.stack || error.message);
    return res.json({
      streams: [],
      tvnetil: {
        success: false,
        imdbId: id,
        metadataTitle,
        error: error.message
      }
    });
  }
});

app.get("/manifest.json", (_, res) => {
  res.json(MANIFEST);
});

app.get("/", (_, res) => {
  res.send("TVNetil Direct Streams 4.0.0");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("TVNetil Direct Streams 4.0.0 started");
});

export default app;
