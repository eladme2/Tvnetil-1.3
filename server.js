import express from "express";

const app = express();

const SERPER_API_KEY = process.env.SERPER_API_KEY;

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "3.7.0",
  name: "TVNetil Direct Streams",
  description:
    "Nuvio Hebrew title -> TVNetil title -> file-host search",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"]
};

/* =========================================================
   HTTP
========================================================= */

async function getJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      Accept: "application/json,text/plain,*/*",
      "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${text.slice(0, 500)}`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Invalid JSON response: ${text.slice(0, 500)}`
    );
  }
}

/* =========================================================
   TEXT
========================================================= */

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCharCode(Number(n))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCharCode(parseInt(n, 16))
    );
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
  return /[\u0590-\u05FF]/u.test(
    String(value || "")
  );
}

/* =========================================================
   SERPER
========================================================= */

async function serperSearch(query, num = 20) {
  if (!SERPER_API_KEY) {
    throw new Error("SERPER_API_KEY is missing");
  }

  console.log("======================================");
  console.log("SERPER QUERY:", query);

  const response = await fetch(
    "https://google.serper.dev/search",
    {
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
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `SERPER HTTP ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

/* =========================================================
   CINEMETA
========================================================= */

async function getMetadata(type, imdbId) {
  const url =
    `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(imdbId)}.json`;

  const data = await getJson(url);

  return data?.meta || data || null;
}

/* =========================================================
   HEBREW TITLE
========================================================= */

function getHebrewTitle(req, metadata) {
  const requestTitle =
    String(req.query.title || "").trim();

  if (requestTitle) {
    if (!hasHebrew(requestTitle)) {
      return null;
    }

    return cleanText(requestTitle);
  }

  const metadataTitle = cleanText(
    metadata?.name ||
    metadata?.title ||
    ""
  );

  if (
    metadataTitle &&
    hasHebrew(metadataTitle)
  ) {
    return metadataTitle;
  }

  return null;
}

/* =========================================================
   TVNETIL SEARCH
========================================================= */

async function searchTVNetil(hebrewTitle) {
  if (
    !hebrewTitle ||
    !hasHebrew(hebrewTitle)
  ) {
    return {
      query: null,
      resultCount: 0,
      results: []
    };
  }

  const query =
    `${hebrewTitle} TVNetil`;

  const data =
    await serperSearch(query, 20);

  const organic =
    Array.isArray(data?.organic)
      ? data.organic
      : [];

  const allResults =
    organic.map(item => ({
      title: item?.title || null,
      link: item?.link || null,
      snippet: item?.snippet || null,
      date: item?.date || null,
      position: item?.position || null
    }));

  const tvnetilResults =
    allResults.filter(item =>
      String(item.link || "")
        .toLowerCase()
        .includes("tvnetil.net/review/")
    );

  return {
    query,
    resultCount: tvnetilResults.length,
    results: tvnetilResults,
    allSearchResults: allResults
  };
}

/* =========================================================
   CHOOSE TVNETIL RESULT
========================================================= */

function chooseTVNetilResult(
  results,
  hebrewTitle
) {
  const wanted =
    normalize(hebrewTitle);

  const words =
    wanted
      .split(" ")
      .filter(word => word.length >= 2);

  let best = null;
  let bestScore = -1;

  for (const item of results) {
    const text =
      normalize(
        `${item.title || ""} ${item.snippet || ""}`
      );

    let score = 0;

    if (text.includes(wanted)) {
      score += 300;
    }

    for (const word of words) {
      if (text.includes(word)) {
        score += 20;
      }
    }

    if (
      words.length > 0 &&
      !words.some(word =>
        text.includes(word)
      )
    ) {
      continue;
    }

    /*
     * תוצאה שמכילה שנה + מדובב
     * עדיפה כאשר קיימת.
     */
    if (
      /\(\d{4}\)/u.test(
        item.title || ""
      )
    ) {
      score += 100;
    }

    if (
      /מדובב/iu.test(
        item.title || ""
      )
    ) {
      score += 100;
    }

    if (score > bestScore) {
      bestScore = score;

      best = {
        ...item,
        score
      };
    }
  }

  return best;
}

/* =========================================================
   GET EXACT TVNETIL TITLE
========================================================= */

function getTVNetilTitle(selected) {
  if (!selected) {
    return null;
  }

  /*
   * חשוב:
   * אנחנו משתמשים בכותרת של תוצאת TVNetil עצמה.
   *
   * לדוגמה:
   * בלאגן ביער (2025) - מדובב
   *
   * לא חוזרים ל-Cinemeta ולא משתמשים
   * בשם האנגלי.
   */

  const title =
    cleanText(selected.title || "");

  if (!title) {
    return null;
  }

  return title;
}

/* =========================================================
   GENERIC SERPER RESULTS
========================================================= */

function mapOrganicResults(data) {
  const organic =
    Array.isArray(data?.organic)
      ? data.organic
      : [];

  return organic.map(item => ({
    title: item?.title || null,
    link: item?.link || null,
    snippet: item?.snippet || null,
    date: item?.date || null,
    position: item?.position || null,
    query: item?.query || null
  }));
}

/* =========================================================
   PIXELDRAIN URL VALIDATION
========================================================= */

function isRealPixelDrainUrl(url) {
  const value =
    String(url || "")
      .trim()
      .toLowerCase();

  if (!value) {
    return false;
  }

  /*
   * דף הבית אינו קובץ.
   */
  if (
    value === "https://pixeldrain.com/" ||
    value === "http://pixeldrain.com/" ||
    value === "https://www.pixeldrain.com/" ||
    value === "http://www.pixeldrain.com/"
  ) {
    return false;
  }

  /*
   * קישור קובץ רגיל.
   */
  if (
    /pixeldrain\.com\/u\/[^/?#]+/i.test(url)
  ) {
    return true;
  }

  /*
   * קישור רשימה.
   */
  if (
    /pixeldrain\.com\/l\/[^/?#]+/i.test(url)
  ) {
    return true;
  }

  /*
   * API של קובץ.
   */
  if (
    /pixeldrain\.com\/api\/file\/[^/?#]+/i.test(url)
  ) {
    return true;
  }

  return false;
}

/* =========================================================
   PIXELDRAIN NORMALIZATION
========================================================= */

function normalizePixelDrainUrl(url) {
  const value =
    String(url || "").trim();

  if (!isRealPixelDrainUrl(value)) {
    return null;
  }

  /*
   * אם זה כבר API:
   */
  if (
    /pixeldrain\.com\/api\/file\//i.test(value)
  ) {
    return value;
  }

  /*
   * /u/ID
   */
  const match =
    value.match(
      /pixeldrain\.com\/u\/([^/?#]+)/i
    );

  if (match?.[1]) {
    return `https://pixeldrain.com/api/file/${match[1]}`;
  }

  /*
   * /l/ID הוא Playlist/List,
   * ולכן לא נהפוך אותו באופן שגוי
   * ל-api/file.
   */
  if (
    /pixeldrain\.com\/l\//i.test(value)
  ) {
    return value;
  }

  return value;
}

/* =========================================================
   PIXELDRAIN SEARCH
========================================================= */

async function searchPixelDrain(tvnetilTitle) {
  if (!tvnetilTitle) {
    return {
      queries: [],
      resultCount: 0,
      results: []
    };
  }

  /*
   * חשוב:
   * השם מגיע ישירות מתוצאת TVNetil.
   */
  const queries = [
    `site:pixeldrain.com "${tvnetilTitle}"`,
    `"${tvnetilTitle}" pixeldrain`,
    `"${tvnetilTitle}" "pixeldrain.com"`,
    `${tvnetilTitle} pixeldrain.com/u`,
    `${tvnetilTitle} pixeldrain.com/l`,
    `${tvnetilTitle} pixeldrain.com/api/file`
  ];

  const collected = [];
  const seen = new Set();

  for (const query of queries) {
    try {
      const data =
        await serperSearch(query, 20);

      const results =
        mapOrganicResults(data);

      for (const item of results) {
        const originalUrl =
          String(item.link || "").trim();

        /*
         * חובה שיהיה קישור PixelDrain אמיתי.
         */
        if (
          !isRealPixelDrainUrl(
            originalUrl
          )
        ) {
          console.log(
            "IGNORED PIXELDRAIN RESULT:",
            originalUrl
          );

          continue;
        }

        const normalizedUrl =
          normalizePixelDrainUrl(
            originalUrl
          );

        if (!normalizedUrl) {
          continue;
        }

        if (
          seen.has(normalizedUrl)
        ) {
          continue;
        }

        seen.add(normalizedUrl);

        collected.push({
          ...item,
          originalUrl,
          normalizedUrl
        });
      }

    } catch (error) {
      console.error(
        "PIXELDRAIN SEARCH ERROR:",
        query,
        error.message
      );
    }
  }

  return {
    queries,
    resultCount: collected.length,
    results: collected
  };
}

/* =========================================================
   GOFILE SEARCH
========================================================= */

function isRealGoFileUrl(url) {
  const value =
    String(url || "").trim();

  return (
    /^https?:\/\/(?:www\.)?gofile\.io\/d\/[^/?#]+/i.test(
      value
    )
  );
}

async function searchGoFile(tvnetilTitle) {
  if (!tvnetilTitle) {
    return {
      queries: [],
      resultCount: 0,
      results: []
    };
  }

  const queries = [
    `site:gofile.io "${tvnetilTitle}"`,
    `"${tvnetilTitle}" GoFile`,
    `"${tvnetilTitle}" "gofile.io"`,
    `${tvnetilTitle} gofile.io/d`
  ];

  const collected = [];
  const seen = new Set();

  for (const query of queries) {
    try {
      const data =
        await serperSearch(query, 20);

      const results =
        mapOrganicResults(data);

      for (const item of results) {
        const link =
          String(item.link || "").trim();

        if (
          !isRealGoFileUrl(link)
        ) {
          continue;
        }

        if (
          seen.has(link)
        ) {
          continue;
        }

        seen.add(link);

        collected.push(item);
      }

    } catch (error) {
      console.error(
        "GOFILE SEARCH ERROR:",
        query,
        error.message
      );
    }
  }

  return {
    queries,
    resultCount: collected.length,
    results: collected
  };
}

/* =========================================================
   STREAMS
========================================================= */

function extractStreams(
  pixelDrainSearch,
  goFileSearch
) {
  const streams = [];
  const seen = new Set();

  /*
   * PixelDrain
   */
  for (
    const item of
    pixelDrainSearch?.results || []
  ) {
    const url =
      item.normalizedUrl ||
      normalizePixelDrainUrl(
        item.originalUrl ||
        item.link
      );

    if (!url) {
      continue;
    }

    if (
      seen.has(url)
    ) {
      continue;
    }

    seen.add(url);

    streams.push({
      name: "PixelDrain",
      title:
        cleanText(
          item.title ||
          "PixelDrain"
        ),
      url,
      type: "http"
    });
  }

  /*
   * GoFile
   */
  for (
    const item of
    goFileSearch?.results || []
  ) {
    const url =
      String(item.link || "").trim();

    if (
      !isRealGoFileUrl(url)
    ) {
      continue;
    }

    if (
      seen.has(url)
    ) {
      continue;
    }

    seen.add(url);

    streams.push({
      name: "GoFile",
      title:
        cleanText(
          item.title ||
          "GoFile"
        ),
      url,
      type: "http"
    });
  }

  return streams;
}

/* =========================================================
   COMPLETE FLOW
========================================================= */

async function resolveTVNetil(
  hebrewTitle
) {
  console.log("======================================");
  console.log("FLOW START");
  console.log("HEBREW TITLE:", hebrewTitle);

  /*
   * 1.
   * עברית -> TVNetil
   */
  const firstSearch =
    await searchTVNetil(
      hebrewTitle
    );

  if (
    !firstSearch.results.length
  ) {
    return {
      success: false,
      step: "tvnetil-search",
      hebrewTitle,
      firstSearch,
      streams: []
    };
  }

  /*
   * 2.
   * בחירת תוצאת TVNetil
   */
  const selected =
    chooseTVNetilResult(
      firstSearch.results,
      hebrewTitle
    );

  if (!selected) {
    return {
      success: false,
      step: "tvnetil-selection",
      hebrewTitle,
      firstSearch,
      streams: []
    };
  }

  /*
   * 3.
   * שם הסרט המדויק מתוצאת TVNetil
   */
  const tvnetilTitle =
    getTVNetilTitle(
      selected
    );

  if (!tvnetilTitle) {
    return {
      success: false,
      step: "tvnetil-result-title",
      hebrewTitle,
      firstSearch,
      tvnetilResult: selected,
      streams: []
    };
  }

  console.log(
    "EXACT TVNETIL TITLE:",
    tvnetilTitle
  );

  /*
   * 4.
   * PixelDrain
   */
  const pixelDrainSearch =
    await searchPixelDrain(
      tvnetilTitle
    );

  /*
   * 5.
   * GoFile
   */
  const goFileSearch =
    await searchGoFile(
      tvnetilTitle
    );

  /*
   * 6.
   * Streams
   */
  const streams =
    extractStreams(
      pixelDrainSearch,
      goFileSearch
    );

  console.log(
    "PIXELDRAIN REAL FILES:",
    pixelDrainSearch.resultCount
  );

  console.log(
    "GOFILE REAL FILES:",
    goFileSearch.resultCount
  );

  console.log(
    "STREAMS:",
    streams.length
  );

  return {
    success:
      streams.length > 0,

    step:
      streams.length > 0
        ? "streams"
        : "results",

    hebrewTitle,

    firstSearch,

    tvnetilResult:
      selected,

    /*
     * זה השם שישמש לחיפוש הקבצים.
     */
    tvnetilTitle,

    pixelDrainSearch,

    goFileSearch,

    streams
  };
}

/* =========================================================
   TEST TITLE
========================================================= */

app.get(
  "/test-title",
  async (req, res) => {
    const title =
      String(
        req.query.q || ""
      ).trim();

    if (!title) {
      return res.json({
        success: false,
        message:
          "Use ?q=שם הסרט בעברית"
      });
    }

    if (!hasHebrew(title)) {
      return res.json({
        success: false,
        step: "hebrew-title",
        inputTitle: title,
        message:
          "No Hebrew title. English search is disabled.",
        streams: []
      });
    }

    try {
      return res.json(
        await resolveTVNetil(title)
      );
    } catch (error) {
      console.error(
        error.stack ||
        error.message
      );

      return res.status(500).json({
        success: false,
        error: error.message,
        streams: []
      });
    }
  }
);

/* =========================================================
   STREAM ENDPOINT
========================================================= */

app.get(
  "/stream/:type/:id.json",
  async (req, res) => {
    const id =
      String(
        req.params.id || ""
      ).trim();

    const type =
      req.params.type === "series"
        ? "series"
        : "movie";

    if (!id) {
      return res.json({
        streams: []
      });
    }

    try {
      /*
       * Cinemeta משמש רק כדי לקבל את
       * השם העברי אם Nuvio לא שולח title.
       */
      const metadata =
        await getMetadata(
          type,
          id
        );

      const metadataTitle =
        cleanText(
          metadata?.name ||
          metadata?.title ||
          ""
        );

      const hebrewTitle =
        getHebrewTitle(
          req,
          metadata
        );

      if (!hebrewTitle) {
        return res.json({
          streams: [],
          tvnetil: {
            success: false,
            imdbId: id,
            metadataTitle,
            step: "hebrew-title",
            message:
              "No Hebrew title available. English search is disabled."
          }
        });
      }

      const result =
        await resolveTVNetil(
          hebrewTitle
        );

      return res.json({
        streams:
          result.streams || [],

        tvnetil: {
          ...result,
          imdbId: id,
          metadataTitle
        }
      });

    } catch (error) {
      console.error(
        error.stack ||
        error.message
      );

      return res.json({
        streams: [],
        tvnetil: {
          success: false,
          imdbId: id,
          metadataTitle: null,
          error: error.message
        }
      });
    }
  }
);

/* =========================================================
   MANIFEST
========================================================= */

app.get(
  "/manifest.json",
  (_, res) => {
    res.json(MANIFEST);
  }
);

/* =========================================================
   HOME
========================================================= */

app.get(
  "/",
  (_, res) => {
    res.send(
      "TVNetil Direct Streams 3.7.0"
    );
  }
);

/* =========================================================
   START
========================================================= */

app.listen(
  process.env.PORT || 3000,
  () => {
    console.log(
      "TVNetil Direct Streams 3.7.0 started"
    );
  }
);

export default app;
