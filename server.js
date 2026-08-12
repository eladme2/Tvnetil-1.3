import express from "express";

const app = express();

const SERPER_API_KEY = process.env.SERPER_API_KEY;

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "3.5.0",
  name: "TVNetil Direct Streams",
  description:
    "Nuvio Hebrew title -> TVNetil -> result title -> search engine -> PixelDrain/GoFile streams",
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
      "Accept":
        "application/json,text/plain,*/*",
      "Accept-Language":
        "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
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
    throw new Error(
      "SERPER_API_KEY is missing"
    );
  }

  console.log(
    "======================================"
  );

  console.log(
    "SERPER QUERY:",
    query
  );

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

  const data =
    await response.json();

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

async function getMetadata(
  type,
  imdbId
) {
  const url =
    `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(imdbId)}.json`;

  const data =
    await getJson(url);

  return (
    data?.meta ||
    data ||
    null
  );
}

/* =========================================================
   HEBREW TITLE
========================================================= */

function getHebrewTitle(
  req,
  metadata
) {
  const requestTitle =
    String(
      req.query.title || ""
    ).trim();

  if (requestTitle) {
    if (
      !hasHebrew(requestTitle)
    ) {
      return null;
    }

    return cleanText(
      requestTitle
    );
  }

  const metadataTitle =
    cleanText(
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
   HEBREW TITLE
   ->
   SEARCH ENGINE
   ->
   TVNETIL
========================================================= */

async function searchTVNetil(
  hebrewTitle
) {
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
    await serperSearch(
      query,
      20
    );

  const organic =
    Array.isArray(
      data?.organic
    )
      ? data.organic
      : [];

  const allResults =
    organic.map(
      item => ({
        title:
          item?.title ||
          null,

        link:
          item?.link ||
          null,

        snippet:
          item?.snippet ||
          null,

        date:
          item?.date ||
          null,

        position:
          item?.position ||
          null
      })
    );

  const tvnetilResults =
    allResults.filter(
      item => {
        const link =
          String(
            item.link || ""
          ).toLowerCase();

        return (
          link.includes(
            "tvnetil.net/review/"
          )
        );
      }
    );

  return {
    query,

    resultCount:
      tvnetilResults.length,

    results:
      tvnetilResults,

    allSearchResults:
      allResults
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
    normalize(
      hebrewTitle
    );

  const words =
    wanted
      .split(" ")
      .filter(
        word =>
          word.length >= 2
      );

  let best = null;
  let bestScore = -1;

  for (
    const item of results
  ) {
    const text =
      normalize(
        `${item.title || ""} ${item.snippet || ""}`
      );

    let score = 0;

    if (
      text.includes(wanted)
    ) {
      score += 300;
    }

    for (
      const word of words
    ) {
      if (
        text.includes(word)
      ) {
        score += 20;
      }
    }

    if (
      words.length > 0 &&
      !words.some(
        word =>
          text.includes(word)
      )
    ) {
      continue;
    }

    if (
      score > bestScore
    ) {
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
   TVNETIL RESULT
   ->
   RESULT TITLE
========================================================= */

function getTVNetilTitle(
  selected
) {
  if (!selected) {
    return null;
  }

  let title =
    cleanText(
      selected.title || ""
    );

  title =
    title.replace(
      /\s*[-|–—]\s*TVNetil.*$/iu,
      ""
    );

  title =
    title.trim();

  return title || null;
}

/* =========================================================
   STEP 4
   TVNETIL TITLE
   ->
   SEARCH ENGINE
   ->
   RESULTS
========================================================= */

async function searchExternal(
  tvnetilTitle
) {
  if (!tvnetilTitle) {
    return {
      query: null,
      resultCount: 0,
      results: [],
      pixelDrainSearch: null,
      goFileSearch: null
    };
  }

  /*
   * חיפוש ראשון:
   * בדיוק הכותרת שהתקבלה מ-TVNetil.
   */

  const query =
    tvnetilTitle;

  const data =
    await serperSearch(
      query,
      20
    );

  const organic =
    Array.isArray(
      data?.organic
    )
      ? data.organic
      : [];

  const externalResults =
    organic
      .map(
        item => ({
          title:
            item?.title ||
            null,

          link:
            item?.link ||
            null,

          snippet:
            item?.snippet ||
            null,

          date:
            item?.date ||
            null,

          position:
            item?.position ||
            null
        })
      )
      .filter(
        item => {
          const link =
            String(
              item.link || ""
            ).toLowerCase();

          return (
            link &&
            !link.includes(
              "tvnetil.net"
            )
          );
        }
      );

  /*
   * -------------------------------------------------------
   * חיפוש נוסף ממוקד PixelDrain
   *
   * לא מחליף את החיפוש המקורי.
   * רק מוסיף חיפוש כדי למצוא את המקור.
   * -------------------------------------------------------
   */

  const pixelQuery =
    `${tvnetilTitle} PixelDrain`;

  let pixelDrainResults = [];

  try {
    const pixelData =
      await serperSearch(
        pixelQuery,
        20
      );

    const pixelOrganic =
      Array.isArray(
        pixelData?.organic
      )
        ? pixelData.organic
        : [];

    pixelDrainResults =
      pixelOrganic.map(
        item => ({
          title:
            item?.title ||
            null,

          link:
            item?.link ||
            null,

          snippet:
            item?.snippet ||
            null,

          date:
            item?.date ||
            null,

          position:
            item?.position ||
            null
        })
      );

  } catch (error) {
    console.error(
      "PIXELDRAIN SEARCH ERROR:",
      error.message
    );
  }

  /*
   * -------------------------------------------------------
   * חיפוש נוסף ממוקד GoFile
   * -------------------------------------------------------
   */

  const goFileQuery =
    `${tvnetilTitle} GoFile`;

  let goFileResults = [];

  try {
    const goFileData =
      await serperSearch(
        goFileQuery,
        20
      );

    const goFileOrganic =
      Array.isArray(
        goFileData?.organic
      )
        ? goFileData.organic
        : [];

    goFileResults =
      goFileOrganic.map(
        item => ({
          title:
            item?.title ||
            null,

          link:
            item?.link ||
            null,

          snippet:
            item?.snippet ||
            null,

          date:
            item?.date ||
            null,

          position:
            item?.position ||
            null
        })
      );

  } catch (error) {
    console.error(
      "GOFILE SEARCH ERROR:",
      error.message
    );
  }

  /*
   * מחברים את כל התוצאות.
   */

  const combinedResults = [
    ...externalResults,
    ...pixelDrainResults,
    ...goFileResults
  ];

  /*
   * מניעת כפילויות לפי URL.
   */

  const unique = new Map();

  for (
    const item of combinedResults
  ) {
    const link =
      String(
        item?.link || ""
      ).trim();

    if (!link) {
      continue;
    }

    if (!unique.has(link)) {
      unique.set(
        link,
        item
      );
    }
  }

  const results =
    Array.from(
      unique.values()
    );

  return {
    query,

    resultCount:
      results.length,

    results,

    pixelDrainSearch: {
      query:
        pixelQuery,

      resultCount:
        pixelDrainResults.length,

      results:
        pixelDrainResults
    },

    goFileSearch: {
      query:
        goFileQuery,

      resultCount:
        goFileResults.length,

      results:
        goFileResults
    }
  };
}

/* =========================================================
   PIXELDRAIN URL
========================================================= */

function normalizePixelDrainUrl(
  url
) {
  const value =
    String(
      url || ""
    ).trim();

  if (!value) {
    return null;
  }

  /*
   * כבר API ישיר.
   */

  const apiMatch =
    value.match(
      /pixeldrain\.com\/api\/file\/([A-Za-z0-9_-]+)/i
    );

  if (apiMatch) {
    return (
      `https://pixeldrain.com/api/file/${apiMatch[1]}`
    );
  }

  /*
   * קישור רגיל:
   * https://pixeldrain.com/u/XXXXXXXX
   */

  const pageMatch =
    value.match(
      /pixeldrain\.com\/u\/([A-Za-z0-9_-]+)/i
    );

  if (pageMatch) {
    return (
      `https://pixeldrain.com/api/file/${pageMatch[1]}`
    );
  }

  /*
   * לפעמים הקישור יכול להיות:
   * pixeldrain.com/l/...
   *
   * בשלב הזה לא נהפוך אותו
   * אוטומטית לקובץ כי זה יכול להיות
   * Folder/List ולא File.
   */

  return null;
}

/* =========================================================
   GOFILE URL
========================================================= */

function normalizeGoFileUrl(
  url
) {
  const value =
    String(
      url || ""
    ).trim();

  if (!value) {
    return null;
  }

  /*
   * כרגע מחזירים את קישור GoFile
   * כפי שנמצא בחיפוש.
   *
   * PixelDrain מקבל עדיפות.
   */

  if (
    /gofile\.io/i.test(value)
  ) {
    return value;
  }

  return null;
}

/* =========================================================
   STEP 5
   FIND PIXELDRAIN / GOFILE
========================================================= */

function findStreamResults(
  results
) {
  if (
    !Array.isArray(results)
  ) {
    return [];
  }

  const streams = [];

  const seen =
    new Set();

  /*
   * -------------------------------------------------------
   * קודם PixelDrain
   * -------------------------------------------------------
   */

  for (
    const item of results
  ) {
    const link =
      String(
        item?.link || ""
      ).trim();

    if (!link) {
      continue;
    }

    const pixelUrl =
      normalizePixelDrainUrl(
        link
      );

    if (!pixelUrl) {
      continue;
    }

    if (
      seen.has(pixelUrl)
    ) {
      continue;
    }

    seen.add(
      pixelUrl
    );

    streams.push({
      name:
        "PixelDrain",

      title:
        cleanText(
          item?.title ||
          "PixelDrain"
        ),

      url:
        pixelUrl,

      type:
        "http"
    });
  }

  /*
   * -------------------------------------------------------
   * אחר כך GoFile
   * -------------------------------------------------------
   */

  for (
    const item of results
  ) {
    const link =
      String(
        item?.link || ""
      ).trim();

    if (!link) {
      continue;
    }

    const goFileUrl =
      normalizeGoFileUrl(
        link
      );

    if (!goFileUrl) {
      continue;
    }

    if (
      seen.has(goFileUrl)
    ) {
      continue;
    }

    seen.add(
      goFileUrl
    );

    streams.push({
      name:
        "GoFile",

      title:
        cleanText(
          item?.title ||
          "GoFile"
        ),

      url:
        goFileUrl,

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
  console.log(
    "======================================"
  );

  console.log(
    "FLOW START"
  );

  console.log(
    "HEBREW TITLE:",
    hebrewTitle
  );

  /* -------------------------------------------------------
     STEP 1
     עברית
     ->
     מנוע חיפוש
     ->
     TVNetil
  ------------------------------------------------------- */

  const firstSearch =
    await searchTVNetil(
      hebrewTitle
    );

  console.log(
    "FIRST SEARCH RESULTS:",
    firstSearch.resultCount
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
     STEP 2
     בחירת תוצאת TVNetil
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

  console.log(
    "TVNETIL RESULT:",
    selected
  );

  /* -------------------------------------------------------
     STEP 3
     לקיחת הכותרת מתוצאת TVNetil
  ------------------------------------------------------- */

  const tvnetilTitle =
    getTVNetilTitle(
      selected
    );

  console.log(
    "TVNETIL TITLE:",
    tvnetilTitle
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

  /* -------------------------------------------------------
     STEP 4
     כותרת TVNetil
     ->
     מנוע חיפוש
     ->
     תוצאות
  ------------------------------------------------------- */

  const secondSearch =
    await searchExternal(
      tvnetilTitle
    );

  console.log(
    "SECOND SEARCH RESULTS:",
    secondSearch.resultCount
  );

  /* -------------------------------------------------------
     STEP 5
     תוצאות
     ->
     PixelDrain / GoFile
  ------------------------------------------------------- */

  const streams =
    findStreamResults(
      secondSearch.results
    );

  console.log(
    "STREAM RESULTS:",
    streams.length
  );

  /*
   * PixelDrain קודם.
   */

  const pixelDrainStreams =
    streams.filter(
      stream =>
        stream.name ===
        "PixelDrain"
    );

  const goFileStreams =
    streams.filter(
      stream =>
        stream.name ===
        "GoFile"
    );

  const orderedStreams = [
    ...pixelDrainStreams,
    ...goFileStreams
  ];

  return {
    success:
      orderedStreams.length > 0,

    step:
      orderedStreams.length > 0
        ? "streams"
        : "results",

    hebrewTitle,

    firstSearch,

    tvnetilResult:
      selected,

    tvnetilTitle,

    secondSearch,

    streamResults:
      orderedStreams,

    streams:
      orderedStreams
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

    /*
     * אין חיפוש באנגלית.
     */

    if (
      !hasHebrew(title)
    ) {
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
      return res.json(
        await resolveTVNetil(
          title
        )
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
      /*
       * METADATA
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

      /*
       * HEBREW TITLE ONLY
       */

      const hebrewTitle =
        getHebrewTitle(
          req,
          metadata
        );

      /*
       * אין שם עברי =
       * אין חיפוש.
       */

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

      /*
       * EXACT FLOW:
       *
       * 1. Hebrew title
       * 2. Search engine
       * 3. TVNetil
       * 4. TVNetil result title
       * 5. Search engine
       * 6. Results
       * 7. PixelDrain / GoFile
       * 8. Streams
       */

      const result =
        await resolveTVNetil(
          hebrewTitle
        );

      return res.json({
        streams:
          result.streams ||
          [],

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
      "TVNetil Direct Streams 3.5.0"
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
      "TVNetil Direct Streams 3.5.0 started"
    );
  }
);

export default app;
