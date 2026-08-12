import express from "express";

const app = express();

const SERPER_API_KEY = process.env.SERPER_API_KEY;

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "3.4.0",
  name: "TVNetil Direct Streams",
  description:
    "Nuvio Hebrew title -> search -> TVNetil -> result title -> search results",
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

  return JSON.parse(text);
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
   SERPER / SCRAPER
========================================================= */

async function scraperSearch(query, num = 20) {
  if (!SERPER_API_KEY) {
    throw new Error(
      "SERPER_API_KEY is missing"
    );
  }

  console.log(
    "SEARCH ENGINE QUERY:",
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
   METADATA
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
    if (!hasHebrew(requestTitle)) {
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
   HEBREW TITLE -> SEARCH ENGINE -> TVNETIL
========================================================= */

async function searchTVNetil(
  hebrewTitle
) {
  if (
    !hebrewTitle ||
    !hasHebrew(hebrewTitle)
  ) {
    return [];
  }

  /*
   * חיפוש רגיל בלבד.
   *
   * אין site:
   * אין -site:
   * אין מרכאות.
   */

  const query =
    hebrewTitle;

  console.log(
    "STEP 1 - SEARCH:",
    query
  );

  const data =
    await scraperSearch(
      query,
      20
    );

  const organic =
    Array.isArray(
      data.organic
    )
      ? data.organic
      : [];

  /*
   * רק לאחר שמנוע החיפוש החזיר
   * את התוצאות, מסננים TVNetil.
   */

  return organic.filter(
    item => {
      const link =
        String(
          item?.link || ""
        ).toLowerCase();

      return link.includes(
        "tvnetil.net/review/"
      );
    }
  );
}

/* =========================================================
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
      bestScore =
        score;

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

function getTVNetilResultTitle(
  selected
) {
  let title =
    cleanText(
      selected?.title || ""
    );

  title =
    title
      .replace(
        /\s*[-|–—]\s*TVNetil.*$/iu,
        ""
      )
      .trim();

  return title || null;
}

/* =========================================================
   STEP 2
   TVNETIL RESULT TITLE -> SEARCH ENGINE
========================================================= */

async function searchFinalEngine(
  tvnetilTitle
) {
  if (!tvnetilTitle) {
    return {
      selected: null,
      results: []
    };
  }

  /*
   * חשוב:
   * משתמשים בדיוק בכותרת שהתקבלה
   * מתוצאת TVNetil.
   */

  const query =
    tvnetilTitle;

  console.log(
    "STEP 2 - SEARCH:",
    query
  );

  const data =
    await scraperSearch(
      query,
      20
    );

  const organic =
    Array.isArray(
      data.organic
    )
      ? data.organic
      : [];

  /*
   * מוציאים תוצאות TVNetil.
   */

  const results =
    organic.filter(
      item => {
        const link =
          String(
            item?.link || ""
          ).toLowerCase();

        return (
          link &&
          !link.includes(
            "tvnetil.net"
          )
        );
      }
    );

  return {
    selected:
      results[0] || null,

    results
  };
}

/* =========================================================
   COMPLETE FLOW
========================================================= */

async function resolveTVNetil(
  hebrewTitle
) {
  /*
   * STEP 1
   */

  const tvnetilResults =
    await searchTVNetil(
      hebrewTitle
    );

  if (
    !tvnetilResults.length
  ) {
    return {
      success: false,

      step:
        "tvnetil-search",

      hebrewTitle,

      streams: []
    };
  }

  /*
   * STEP 2
   */

  const selected =
    chooseTVNetilResult(
      tvnetilResults,
      hebrewTitle
    );

  if (!selected) {
    return {
      success: false,

      step:
        "tvnetil-selection",

      hebrewTitle,

      tvnetilResults,

      streams: []
    };
  }

  /*
   * STEP 3
   */

  const tvnetilTitle =
    getTVNetilResultTitle(
      selected
    );

  if (!tvnetilTitle) {
    return {
      success: false,

      step:
        "tvnetil-result-title",

      hebrewTitle,

      tvnetilUrl:
        selected.link,

      streams: []
    };
  }

  /*
   * STEP 4
   */

  const finalSearch =
    await searchFinalEngine(
      tvnetilTitle
    );

  return {
    success:
      Boolean(
        finalSearch.selected
      ),

    hebrewTitle,

    tvnetilTitle,

    tvnetilUrl:
      selected.link,

    finalSearchTitle:
      tvnetilTitle,

    finalSearchResult:
      finalSearch.selected
        ? {
            title:
              finalSearch.selected.title ||
              null,

            snippet:
              finalSearch.selected.snippet ||
              null,

            link:
              finalSearch.selected.link
          }
        : null,

    searchResults:
      finalSearch.results,

    streams: []
  };
}

/* =========================================================
   DEBUG SEARCH
========================================================= */

app.get(
  "/debug-search",
  async (req, res) => {
    const title =
      String(
        req.query.q || ""
      ).trim();

    if (!title) {
      return res.json({
        success: false,

        message:
          "Use ?q=שם הסרט"
      });
    }

    if (!hasHebrew(title)) {
      return res.json({
        success: false,

        step:
          "hebrew-title",

        message:
          "Hebrew title required."
      });
    }

    try {
      const data =
        await scraperSearch(
          title,
          20
        );

      return res.json({
        success: true,

        query:
          title,

        organic:
          data.organic || [],

        tvnetilResults:
          Array.isArray(
            data.organic
          )
            ? data.organic.filter(
                item =>
                  String(
                    item?.link || ""
                  )
                    .toLowerCase()
                    .includes(
                      "tvnetil.net/review/"
                    )
              )
            : []
      });
    } catch (error) {
      return res.status(500).json({
        success: false,

        error:
          error.message
      });
    }
  }
);

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
   STREAM
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
       * חייב להיות שם עברי.
       */

      const hebrewTitle =
        getHebrewTitle(
          req,
          metadata
        );

      /*
       * אין שם עברי:
       * עוצרים מיד.
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
       * הסדר:
       *
       * Nuvio
       * ↓
       * Hebrew title
       * ↓
       * Scraper
       * ↓
       * TVNetil
       * ↓
       * TVNetil result title
       * ↓
       * Scraper
       * ↓
       * Search results
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
      "TVNetil Direct Streams 3.4.0"
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
      "TVNetil Direct Streams 3.4.0 started"
    );
  }
);

export default app;
