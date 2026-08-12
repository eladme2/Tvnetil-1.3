import express from "express";

const app = express();

const SERPER_API_KEY = process.env.SERPER_API_KEY;

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "3.3.0",
  name: "TVNetil Search Debug",
  description:
    "Nuvio Hebrew title -> search -> TVNetil result -> result title -> second search -> results",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"]
};

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
   HTTP / CINEMETA
========================================================= */

async function getJson(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      "Accept":
        "application/json,text/plain,*/*",
      "Accept-Language":
        "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7"
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

async function getMetadata(type, imdbId) {
  const url =
    `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(imdbId)}.json`;

  const data = await getJson(url);

  return data?.meta || data || null;
}

/* =========================================================
   SERPER
========================================================= */

async function scraperSearch(query, num = 20) {
  if (!SERPER_API_KEY) {
    throw new Error("SERPER_API_KEY is missing");
  }

  console.log("======================================");
  console.log("SEARCH ENGINE QUERY:");
  console.log(query);

  const response = await fetch(
    "https://google.serper.dev/search",
    {
      method: "POST",

      headers: {
        "X-API-KEY": SERPER_API_KEY,
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        /*
         * חשוב:
         * אין site:
         * אין -site:
         * אין מרכאות.
         *
         * הסינון נעשה רק אחרי
         * שמנוע החיפוש החזיר תוצאות.
         */
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
   HEBREW TITLE
========================================================= */

function getHebrewTitle(req, metadata) {
  /*
   * קודם title שמגיע מ-Nuvio.
   */

  const requestTitle =
    String(req.query.title || "").trim();

  if (requestTitle) {
    if (!hasHebrew(requestTitle)) {
      return null;
    }

    return cleanText(requestTitle);
  }

  /*
   * fallback למטאדאטה.
   * גם כאן עברית בלבד.
   */

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
   HEBREW -> SEARCH ENGINE
========================================================= */

async function searchTVNetil(hebrewTitle) {
  if (
    !hebrewTitle ||
    !hasHebrew(hebrewTitle)
  ) {
    return {
      query: hebrewTitle || "",
      organic: [],
      tvnetilResults: []
    };
  }

  /*
   * החיפוש הראשון הוא בדיוק השם העברי.
   *
   * לא site:
   * לא מרכאות.
   * לא חיפוש באנגלית.
   */

  const query = hebrewTitle;

  const data = await scraperSearch(
    query,
    20
  );

  const organic =
    Array.isArray(data.organic)
      ? data.organic
      : [];

  console.log(
    "FIRST SEARCH RESULTS:",
    organic.length
  );

  /*
   * רק עכשיו מסננים את TVNetil.
   */

  const tvnetilResults =
    organic.filter((item) => {
      const link = String(
        item?.link || ""
      ).toLowerCase();

      return link.includes(
        "tvnetil.net"
      );
    });

  console.log(
    "TVNETIL RESULTS:",
    tvnetilResults.length
  );

  return {
    query,
    organic,
    tvnetilResults
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
      .filter(
        word => word.length >= 2
      );

  let best = null;
  let bestScore = -1;

  for (const item of results) {
    const text = normalize(
      `${item.title || ""} ${item.snippet || ""}`
    );

    let score = 0;

    /*
     * התאמה מלאה.
     */

    if (text.includes(wanted)) {
      score += 300;
    }

    /*
     * התאמת מילים.
     */

    for (const word of words) {
      if (text.includes(word)) {
        score += 20;
      }
    }

    /*
     * אין אפילו מילה אחת תואמת:
     * לא התוצאה שלנו.
     */

    if (
      words.length > 0 &&
      !words.some(
        word => text.includes(word)
      )
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
   STEP 3
   TITLE FROM TVNETIL RESULT
========================================================= */

function getTVNetilTitle(selected) {
  if (!selected) {
    return null;
  }

  let title = cleanText(
    selected.title || ""
  );

  /*
   * ניקוי סיומת TVNetil בלבד.
   */

  title = title
    .replace(
      /\s*[-|–—]\s*TVNetil.*$/iu,
      ""
    )
    .trim();

  return title || null;
}

/* =========================================================
   STEP 4
   TVNETIL RESULT TITLE -> SECOND SEARCH
========================================================= */

async function searchSecondEngine(tvnetilTitle) {
  if (!tvnetilTitle) {
    return {
      query: "",
      organic: []
    };
  }

  /*
   * זה השלב השני.

   * לוקחים בדיוק את הכותרת
   * שהתקבלה מתוצאת TVNetil
   *
   * ושולחים אותה למנוע החיפוש.
   *
   * שוב:
   * אין site:
   * אין -site:
   * אין מרכאות.
   */

  const query = tvnetilTitle;

  const data = await scraperSearch(
    query,
    20
  );

  const organic =
    Array.isArray(data.organic)
      ? data.organic
      : [];

  console.log(
    "SECOND SEARCH RESULTS:",
    organic.length
  );

  return {
    query,
    organic
  };
}

/* =========================================================
   COMPLETE DEBUG FLOW
========================================================= */

async function resolveSearchFlow(hebrewTitle) {
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

  /*
   * STEP 1
   * Hebrew -> search engine
   */

  const firstSearch =
    await searchTVNetil(
      hebrewTitle
    );

  if (
    !firstSearch.tvnetilResults.length
  ) {
    return {
      success: false,

      step:
        "tvnetil-search",

      hebrewTitle,

      firstSearch: {
        query:
          firstSearch.query,

        resultCount:
          firstSearch.organic.length,

        results:
          firstSearch.organic
      },

      streams: []
    };
  }

  /*
   * STEP 2
   * Select TVNetil result
   */

  const selected =
    chooseTVNetilResult(
      firstSearch.tvnetilResults,
      hebrewTitle
    );

  if (!selected) {
    return {
      success: false,

      step:
        "tvnetil-selection",

      hebrewTitle,

      tvnetilResults:
        firstSearch.tvnetilResults,

      streams: []
    };
  }

  /*
   * STEP 3
   * Take title from result
   */

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

      tvnetilResult:
        selected,

      streams: []
    };
  }

  /*
   * STEP 4
   * TVNetil title -> second search
   */

  const secondSearch =
    await searchSecondEngine(
      tvnetilTitle
    );

  /*
   * כאן עוצרים.
   *
   * מציגים את כל תוצאות
   * החיפוש השני.
   */

  return {
    success: true,

    step:
      "search-results",

    hebrewTitle,

    tvnetilResult: {
      title:
        selected.title || null,

      snippet:
        selected.snippet || null,

      link:
        selected.link || null,

      score:
        selected.score
    },

    tvnetilTitle,

    secondSearch: {
      query:
        secondSearch.query,

      resultCount:
        secondSearch.organic.length,

      results:
        secondSearch.organic.map(
          item => ({
            title:
              item.title || null,

            snippet:
              item.snippet || null,

            link:
              item.link || null
          })
        )
    },

    /*
     * בשלב הזה אין יצירת Stream.
     */

    streams: []
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
          "Use /test-title?q=שם הסרט בעברית"
      });
    }

    /*
     * English disabled.
     */

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
        await resolveSearchFlow(
          title
        );

      return res.json(result);

    } catch (error) {
      console.error(
        error.stack ||
        error.message
      );

      return res.status(500).json({
        success: false,

        step:
          "error",

        error:
          error.message,

        streams: []
      });
    }
  }
);

/* =========================================================
   STREAM ENDPOINT
   DEBUG ONLY
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
       * Get Nuvio / Cinemeta metadata.
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
       * Hebrew title only.
       */

      const hebrewTitle =
        getHebrewTitle(
          req,
          metadata
        );

      /*
       * No Hebrew:
       * absolutely no search.
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
       * Run exact flow.
       */

      const result =
        await resolveSearchFlow(
          hebrewTitle
        );

      return res.json({
        ...result,

        imdbId:
          id,

        metadataTitle
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
      "TVNetil Search Debug 3.3.0"
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
      "TVNetil Search Debug 3.3.0 started"
    );
  }
);

export default app;
