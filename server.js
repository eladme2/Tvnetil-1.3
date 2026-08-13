import express from "express";

const app = express();

const SERPER_API_KEY = process.env.SERPER_API_KEY;

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "3.6.0",
  name: "TVNetil Direct Streams",
  description:
    "Hebrew title -> TVNetil result title -> PixelDrain / GoFile streams",
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
   STEP 1
   HEBREW TITLE -> TVNETIL
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

  const allSearchResults =
    organic.map(item => ({
      title: item?.title || null,
      link: item?.link || null,
      snippet: item?.snippet || null,
      date: item?.date || null,
      position: item?.position || null
    }));

  const results =
    allSearchResults.filter(item => {
      const link =
        String(item.link || "").toLowerCase();

      return link.includes(
        "tvnetil.net/review/"
      );
    });

  return {
    query,
    resultCount: results.length,
    results,
    allSearchResults
  };
}

/* =========================================================
   STEP 2
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
    const titleText =
      normalize(item.title || "");

    const snippetText =
      normalize(item.snippet || "");

    const text =
      `${titleText} ${snippetText}`;

    let score = 0;

    /*
     * עדיפות גבוהה מאוד לכותרת התוצאה עצמה.
     */

    if (
      titleText.includes(wanted)
    ) {
      score += 500;
    }

    if (
      text.includes(wanted)
    ) {
      score += 300;
    }

    for (const word of words) {
      if (titleText.includes(word)) {
        score += 40;
      } else if (snippetText.includes(word)) {
        score += 15;
      }
    }

    /*
     * TVNetil תמיד צריך להיות קשור לשם שחיפשנו.
     */

    if (
      words.length > 0 &&
      !words.some(word =>
        text.includes(word)
      )
    ) {
      continue;
    }

    /*
     * תוצאה עם /review/ID/ID עדיפה על עמוד כללי.
     */

    if (
      /\/review\/\d+\/\d+/i.test(
        String(item.link || "")
      )
    ) {
      score += 100;
    }

    /*
     * מדובב הוא בדרך כלל התוכן שאנחנו רוצים
     * כאשר התוצאה של TVNetil מציינת אותו.
     */

    if (
      /מדובב/i.test(
        String(item.title || "")
      )
    ) {
      score += 50;
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
   STEP 3
   TVNETIL RESULT TITLE
========================================================= */

function getTVNetilTitle(selected) {
  if (!selected) {
    return null;
  }

  /*
   * חשוב:
   * אנחנו לוקחים את title של תוצאת Google
   * של TVNetil.
   *
   * לא מנסים לפתוח את הדף עצמו,
   * כי TVNetil מחזיר Cloudflare 403.
   */

  let title =
    cleanText(
      selected.title || ""
    );

  /*
   * הסרת שם האתר בלבד אם Google הוסיף אותו.
   */

  title =
    title
      .replace(
        /\s*[-|–—]\s*TVNetil\.net.*$/iu,
        ""
      )
      .replace(
        /^TVNetil\.net\s*[-|–—]\s*/iu,
        ""
      )
      .trim();

  return title || null;
}

/* =========================================================
   PIXELDRAIN URL NORMALIZATION
========================================================= */

function normalizePixelDrainUrl(link) {
  const value =
    String(link || "").trim();

  if (!value) {
    return null;
  }

  try {
    const url =
      new URL(value);

    const host =
      url.hostname.toLowerCase();

    if (
      !host.includes("pixeldrain.com")
    ) {
      return null;
    }

    /*
     * /api/file/ID
     */

    const apiMatch =
      url.pathname.match(
        /\/api\/file\/([^/?#]+)/i
      );

    if (apiMatch?.[1]) {
      return (
        `https://pixeldrain.com/api/file/${apiMatch[1]}`
      );
    }

    /*
     * /u/ID
     */

    const userMatch =
      url.pathname.match(
        /\/u\/([^/?#]+)/i
      );

    if (userMatch?.[1]) {
      return (
        `https://pixeldrain.com/api/file/${userMatch[1]}`
      );
    }

    /*
     * /l/ID
     *
     * זה קישור לתיקייה/רשימה.
     * לא ממירים אותו ל-api/file כי אין
     * ודאות שהוא File ID.
     */

    const listMatch =
      url.pathname.match(
        /\/l\/([^/?#]+)/i
      );

    if (listMatch?.[1]) {
      return (
        `https://pixeldrain.com/l/${listMatch[1]}`
      );
    }

    return value;

  } catch {
    return value;
  }
}

/* =========================================================
   PIXELDRAIN IDENTIFICATION
========================================================= */

function isPixelDrainUrl(link) {
  return /pixeldrain\.com/i.test(
    String(link || "")
  );
}

/* =========================================================
   STEP 4
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
   * אין מרכאות!
   *
   * Serper בחשבון החינמי מחזיר:
   * Query pattern not allowed
   * עבור חלק מהחיפושים עם quotes.
   */

  const queries = [
    `site:pixeldrain.com ${tvnetilTitle}`,
    `${tvnetilTitle} pixeldrain`,
    `${tvnetilTitle} PixelDrain`,
    `${tvnetilTitle} pixeldrain.com`,
    `${tvnetilTitle} pixeldrain.com/u`,
    `${tvnetilTitle} pixeldrain.com/l`,
    `${tvnetilTitle} pixeldrain.com/api/file`
  ];

  const collected = [];
  const seen = new Set();

  for (const query of queries) {
    try {
      const data =
        await serperSearch(
          query,
          20
        );

      const organic =
        Array.isArray(data?.organic)
          ? data.organic
          : [];

      for (const item of organic) {
        const result = {
          title:
            item?.title || null,

          link:
            item?.link || null,

          snippet:
            item?.snippet || null,

          date:
            item?.date || null,

          position:
            item?.position || null,

          query
        };

        const link =
          String(
            result.link || ""
          ).trim();

        if (!link) {
          continue;
        }

        if (
          !isPixelDrainUrl(link)
        ) {
          continue;
        }

        const finalUrl =
          normalizePixelDrainUrl(
            link
          );

        if (!finalUrl) {
          continue;
        }

        if (
          seen.has(finalUrl)
        ) {
          continue;
        }

        seen.add(finalUrl);

        collected.push({
          ...result,
          normalizedUrl: finalUrl
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
    resultCount:
      collected.length,
    results:
      collected
  };
}

/* =========================================================
   STEP 5
   GOFILE SEARCH
========================================================= */

async function searchGoFile(tvnetilTitle) {
  if (!tvnetilTitle) {
    return {
      queries: [],
      resultCount: 0,
      results: []
    };
  }

  const queries = [
    `site:gofile.io ${tvnetilTitle}`,
    `${tvnetilTitle} GoFile`,
    `${tvnetilTitle} gofile.io`,
    `${tvnetilTitle} gofile.io/d`
  ];

  const collected = [];
  const seen = new Set();

  for (const query of queries) {
    try {
      const data =
        await serperSearch(
          query,
          20
        );

      const organic =
        Array.isArray(data?.organic)
          ? data.organic
          : [];

      for (const item of organic) {
        const result = {
          title:
            item?.title || null,

          link:
            item?.link || null,

          snippet:
            item?.snippet || null,

          date:
            item?.date || null,

          position:
            item?.position || null,

          query
        };

        const link =
          String(
            result.link || ""
          ).trim();

        if (!link) {
          continue;
        }

        if (
          !/gofile\.io/i.test(link)
        ) {
          continue;
        }

        if (
          seen.has(link)
        ) {
          continue;
        }

        seen.add(link);

        collected.push(
          result
        );
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
    resultCount:
      collected.length,
    results:
      collected
  };
}

/* =========================================================
   STEP 6
   EXTRACT STREAMS
========================================================= */

function extractStreams(
  pixelDrainSearch,
  goFileSearch
) {
  const streams = [];
  const seen = new Set();

  /* -------------------------------------------------------
     PixelDrain
  ------------------------------------------------------- */

  for (
    const item of
    pixelDrainSearch?.results || []
  ) {
    const url =
      normalizePixelDrainUrl(
        item?.normalizedUrl ||
        item?.link
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
      name:
        "PixelDrain",

      title:
        cleanText(
          item?.title ||
          "PixelDrain"
        ),

      url,

      type:
        "http"
    });
  }

  /* -------------------------------------------------------
     GoFile
  ------------------------------------------------------- */

  for (
    const item of
    goFileSearch?.results || []
  ) {
    const url =
      String(
        item?.link || ""
      ).trim();

    if (!url) {
      continue;
    }

    if (
      !/gofile\.io/i.test(url)
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
      name:
        "GoFile",

      title:
        cleanText(
          item?.title ||
          "GoFile"
        ),

      url,

      type:
        "http"
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
  console.log(
    "HEBREW TITLE:",
    hebrewTitle
  );

  /* -------------------------------------------------------
     1. Hebrew title -> TVNetil
  ------------------------------------------------------- */

  const firstSearch =
    await searchTVNetil(
      hebrewTitle
    );

  if (
    !firstSearch.results.length
  ) {
    return {
      success: false,
      step:
        "tvnetil-search",
      hebrewTitle,
      firstSearch,
      streams: []
    };
  }

  /* -------------------------------------------------------
     2. Select TVNetil result
  ------------------------------------------------------- */

  const selected =
    chooseTVNetilResult(
      firstSearch.results,
      hebrewTitle
    );

  if (!selected) {
    return {
      success: false,
      step:
        "tvnetil-selection",
      hebrewTitle,
      firstSearch,
      streams: []
    };
  }

  /* -------------------------------------------------------
     3. IMPORTANT:
        Take the title from the TVNetil search result
  ------------------------------------------------------- */

  const tvnetilTitle =
    getTVNetilTitle(
      selected
    );

  if (!tvnetilTitle) {
    return {
      success: false,
      step:
        "tvnetil-result-title",
      hebrewTitle,
      firstSearch,
      tvnetilResult:
        selected,
      streams: []
    };
  }

  console.log(
    "======================================"
  );

  console.log(
    "TVNETIL RESULT:",
    selected.title
  );

  console.log(
    "TVNETIL SEARCH TITLE:",
    tvnetilTitle
  );

  /* -------------------------------------------------------
     4. PixelDrain
  ------------------------------------------------------- */

  const pixelDrainSearch =
    await searchPixelDrain(
      tvnetilTitle
    );

  /* -------------------------------------------------------
     5. GoFile
  ------------------------------------------------------- */

  const goFileSearch =
    await searchGoFile(
      tvnetilTitle
    );

  /* -------------------------------------------------------
     6. Build streams
  ------------------------------------------------------- */

  const streams =
    extractStreams(
      pixelDrainSearch,
      goFileSearch
    );

  console.log(
    "======================================"
  );

  console.log(
    "PIXELDRAIN RESULTS:",
    pixelDrainSearch.resultCount
  );

  console.log(
    "GOFILE RESULTS:",
    goFileSearch.resultCount
  );

  console.log(
    "FINAL STREAMS:",
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
        step:
          "hebrew-title",
        inputTitle:
          title,
        message:
          "No Hebrew title. English search is disabled.",
        streams: []
      });
    }

    try {
      const result =
        await resolveTVNetil(
          title
        );

      return res.json(
        result
      );

    } catch (error) {
      console.error(
        error.stack ||
        error.message
      );

      return res.status(500).json({
        success: false,
        error:
          error.message,
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
      /* ---------------------------------------------------
         Cinemeta
      --------------------------------------------------- */

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

      /* ---------------------------------------------------
         Hebrew title
      --------------------------------------------------- */

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
            imdbId:
              id,
            metadataTitle,
            step:
              "hebrew-title",
            message:
              "No Hebrew title available. English search is disabled."
          }
        });
      }

      /* ---------------------------------------------------
         Full flow
      --------------------------------------------------- */

      const result =
        await resolveTVNetil(
          hebrewTitle
        );

      return res.json({
        streams:
          result.streams || [],

        tvnetil: {
          ...result,
          imdbId:
            id,
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
          imdbId:
            id,
          metadataTitle:
            null,
          error:
            error.message
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
    res.json(
      MANIFEST
    );
  }
);

/* =========================================================
   HOME
========================================================= */

app.get(
  "/",
  (_, res) => {
    res.send(
      "TVNetil Direct Streams 3.6.0"
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
      "TVNetil Direct Streams 3.6.0 started"
    );
  }
);

export default app;
