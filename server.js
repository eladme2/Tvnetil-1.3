import express from "express";

const app = express();

const SERPER_API_KEY = process.env.SERPER_API_KEY;

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "4.0.0",
  name: "TVNetil Direct Streams",
  description:
    "Nuvio Hebrew title -> TVNetil -> exact TVNetil title -> Fave -> PixelDrain/GoFile",
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
   NUVIO HEBREW TITLE -> TVNETIL THROUGH SERPER
========================================================= */

async function searchTVNetil(hebrewTitle) {
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
    allResults.filter(item => {
      const link =
        String(item.link || "").toLowerCase();

      return link.includes(
        "tvnetil.net/review/"
      );
    });

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
      score += 500;
    }

    for (const word of words) {
      if (text.includes(word)) {
        score += 30;
      }
    }

    /*
     * תוצאת review/מספר/מספר עדיפה
     * על דף review כללי.
     */
    const link =
      String(item.link || "").toLowerCase();

    if (
      /\/review\/\d+\/\d+/.test(link)
    ) {
      score += 300;
    }

    /*
     * מדובב חשוב מאוד כאשר Nuvio מחפש
     * את הגרסה העברית/מדובבת.
     */
    if (
      /מדובב/i.test(
        `${item.title || ""} ${item.snippet || ""}`
      )
    ) {
      score += 100;
    }

    if (
      words.length > 0 &&
      !words.some(word => text.includes(word))
    ) {
      continue;
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
   TVNETIL RESULT TITLE
========================================================= */

function getTVNetilTitle(selected) {
  if (!selected) {
    return null;
  }

  /*
   * החשוב:
   * קודם כל משתמשים בכותרת כפי ש־Serper קיבל
   * מדף TVNetil.
   *
   * לא מחפשים שם חלופי.
   */

  let title =
    cleanText(selected.title || "");

  /*
   * מסירים רק תוספת שמייצגת את האתר עצמו,
   * לא את "(2025) - מדובב".
   */

  title =
    title.replace(
      /\s*[-|–—]\s*TVNetil.*$/iu,
      ""
    );

  title =
    title.replace(
      /^TVNetil\.net\s*[-|:]\s*/iu,
      ""
    );

  return title.trim() || null;
}

/* =========================================================
   STEP 2
   EXACT TVNETIL TITLE -> FAVE THROUGH SERPER
========================================================= */

async function searchFave(tvnetilTitle) {
  if (!tvnetilTitle) {
    return {
      queries: [],
      resultCount: 0,
      results: []
    };
  }

  /*
   * חשוב:
   *
   * אנחנו לא מחפשים PixelDrain/GoFile בגוגל.
   *
   * Serper משמש רק כדי למצוא תוצאות של Fave
   * עבור השם המדויק שהגיע מ־TVNetil.
   */

  const queries = [
    `site:favez0ne.net "${tvnetilTitle}"`,
    `site:favez0ne.net ${tvnetilTitle}`,
    `site:favez0ne.net "${tvnetilTitle}" Fave`,
    `site:favez0ne.net "${tvnetilTitle}" "pixeldrain"`,
    `site:favez0ne.net "${tvnetilTitle}" "gofile"`
  ];

  const collected = [];
  const seen = new Set();

  for (const query of queries) {
    try {
      const data =
        await serperSearch(query, 20);

      const organic =
        Array.isArray(data?.organic)
          ? data.organic
          : [];

      for (const item of organic) {
        const result = {
          title: item?.title || null,
          link: item?.link || null,
          snippet: item?.snippet || null,
          date: item?.date || null,
          position: item?.position || null,
          query
        };

        const link =
          String(result.link || "").trim();

        /*
         * רק תוצאות Fave.
         */
        if (
          !link
            .toLowerCase()
            .includes("favez0ne.net")
        ) {
          continue;
        }

        if (seen.has(link)) {
          continue;
        }

        seen.add(link);
        collected.push(result);
      }
    } catch (error) {
      console.error(
        "FAVE SEARCH ERROR:",
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
   EXTRACT URLS FROM FAVE RESULT
========================================================= */

function extractUrlsFromText(text) {
  const value =
    String(text || "");

  const urls =
    value.match(
      /https?:\/\/[^\s<>"')\]]+/gi
    ) || [];

  return urls.map(url =>
    url
      .replace(/[.,;!?]+$/g, "")
      .trim()
  );
}

/* =========================================================
   VALID PIXELDRAIN
========================================================= */

function normalizePixelDrainUrl(url) {
  let value =
    String(url || "")
      .trim()
      .replace(/[.,;!?]+$/g, "");

  if (!value) {
    return null;
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  const host =
    parsed.hostname.toLowerCase();

  if (
    host !== "pixeldrain.com" &&
    host !== "www.pixeldrain.com"
  ) {
    return null;
  }

  /*
   * אסור להחזיר את דף הבית.
   */

  if (
    parsed.pathname === "/" ||
    parsed.pathname === ""
  ) {
    return null;
  }

  /*
   * API אמיתי:
   * /api/file/ID
   */
  const apiMatch =
    parsed.pathname.match(
      /^\/api\/file\/([A-Za-z0-9_-]+)\/?$/i
    );

  if (apiMatch) {
    return {
      url:
        `https://pixeldrain.com/api/file/${apiMatch[1]}`,
      id:
        apiMatch[1]
    };
  }

  /*
   * /u/ID
   */
  const userMatch =
    parsed.pathname.match(
      /^\/u\/([A-Za-z0-9_-]+)\/?$/i
    );

  if (userMatch) {
    return {
      url:
        `https://pixeldrain.com/api/file/${userMatch[1]}`,
      id:
        userMatch[1]
    };
  }

  /*
   * /l/ID הוא אלבום ולא קובץ יחיד.
   * לא מחזירים אותו כקובץ סרט.
   */

  if (
    /^\/l\/[A-Za-z0-9_-]+/i.test(
      parsed.pathname
    )
  ) {
    return null;
  }

  return null;
}

/* =========================================================
   VALID GOFILE
========================================================= */

function normalizeGoFileUrl(url) {
  let value =
    String(url || "")
      .trim()
      .replace(/[.,;!?]+$/g, "");

  if (!value) {
    return null;
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  const host =
    parsed.hostname.toLowerCase();

  if (
    host !== "gofile.io" &&
    host !== "www.gofile.io"
  ) {
    return null;
  }

  const match =
    parsed.pathname.match(
      /^\/d\/([A-Za-z0-9_-]+)\/?$/i
    );

  if (!match) {
    return null;
  }

  return {
    url:
      `https://gofile.io/d/${match[1]}`,
    id:
      match[1]
  };
}

/* =========================================================
   EXTRACT ONLY SOURCES FOUND IN FAVE RESULTS
========================================================= */

function extractFaveStreams(faveSearch) {
  const streams = [];
  const seen = new Set();

  for (
    const result of
    faveSearch?.results || []
  ) {
    /*
     * חשוב:
     *
     * אנחנו מסתכלים רק על תוכן תוצאת Fave:
     * title + snippet + link.
     *
     * לא מבצעים חיפוש חדש ב־Google
     * עבור PixelDrain/GoFile.
     */

    const sourceText =
      [
        result.title,
        result.snippet,
        result.link
      ]
        .filter(Boolean)
        .join(" ");

    const urls =
      extractUrlsFromText(
        sourceText
      );

    /*
     * אם Fave/Serper החזירו קישור
     * ישיר ל־PixelDrain/GoFile.
     */

    for (const rawUrl of urls) {
      const pixel =
        normalizePixelDrainUrl(
          rawUrl
        );

      if (pixel) {
        if (
          seen.has(pixel.url)
        ) {
          continue;
        }

        seen.add(pixel.url);

        streams.push({
          name: "PixelDrain",
          title:
            cleanText(
              result.title ||
              "PixelDrain"
            ),
          url: pixel.url,
          type: "http"
        });

        continue;
      }

      const gofile =
        normalizeGoFileUrl(
          rawUrl
        );

      if (gofile) {
        if (
          seen.has(gofile.url)
        ) {
          continue;
        }

        seen.add(gofile.url);

        streams.push({
          name: "GoFile",
          title:
            cleanText(
              result.title ||
              "GoFile"
            ),
          url: gofile.url,
          type: "http"
        });
      }
    }
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
  console.log("NUVIO HEBREW TITLE:", hebrewTitle);

  /* -------------------------------------------------------
     1. Nuvio -> Serper -> TVNetil
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
      step: "tvnetil-search",
      hebrewTitle,
      firstSearch,
      streams: []
    };
  }

  /* -------------------------------------------------------
     2. Choose TVNetil page
  ------------------------------------------------------- */

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

  /* -------------------------------------------------------
     3. Take EXACT TVNetil title
  ------------------------------------------------------- */

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
    "TVNETIL EXACT TITLE:",
    tvnetilTitle
  );

  /* -------------------------------------------------------
     4. Search Fave ONLY using the TVNetil title
  ------------------------------------------------------- */

  const faveSearch =
    await searchFave(
      tvnetilTitle
    );

  console.log(
    "FAVE RESULTS:",
    faveSearch.resultCount
  );

  /* -------------------------------------------------------
     5. Extract only links appearing in Fave results
  ------------------------------------------------------- */

  const streams =
    extractFaveStreams(
      faveSearch
    );

  console.log(
    "FAVE STREAMS:",
    streams.length
  );

  return {
    success:
      streams.length > 0,

    step:
      streams.length > 0
        ? "streams"
        : "fave-results",

    hebrewTitle,

    firstSearch,

    tvnetilResult:
      selected,

    tvnetilTitle,

    faveSearch,

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

    let metadataTitle = null;

    try {
      const metadata =
        await getMetadata(
          type,
          id
        );

      metadataTitle =
        cleanText(
          metadata?.name ||
          metadata?.title ||
          ""
        );

      /*
       * Nuvio title query תמיד עדיף.
       * אם הוא לא קיים, ננסה Cinemeta,
       * אבל רק אם הוא עברית.
       */

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
          metadataTitle,
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
      "TVNetil Direct Streams 4.0.0"
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
      "TVNetil Direct Streams 4.0.0 started"
    );
  }
);

export default app;
