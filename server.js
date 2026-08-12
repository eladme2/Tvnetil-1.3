import express from "express";

const app = express();

const SERPER_API_KEY = process.env.SERPER_API_KEY;

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "3.3.0",
  name: "TVNetil Direct Streams",
  description:
    "Nuvio Hebrew title -> TVNetil -> result title -> search engine -> results",
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
        /*
         * בכוונה אין:
         * site:
         * -site:
         * מרכאות
         *
         * כדי להיות תואם ל-Serper Free.
         */

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
  /*
   * קודם כל title שמגיע מ-Nuvio.
   */

  const requestTitle =
    String(
      req.query.title || ""
    ).trim();

  if (requestTitle) {
    /*
     * אם Nuvio שלח שם באנגלית,
     * לא מחפשים בכלל.
     */

    if (
      !hasHebrew(requestTitle)
    ) {
      return null;
    }

    return cleanText(
      requestTitle
    );
  }

  /*
   * fallback למטאדאטה.
   *
   * גם כאן עברית בלבד.
   */

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
   NUVIO HEBREW TITLE
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

  /*
   * חשוב:
   *
   * לא משתמשים ב-site:
   * לא משתמשים במרכאות.
   *
   * מוסיפים TVNetil למונח החיפוש
   * כדי לכוון את מנוע החיפוש לאתר.
   */

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

  /*
   * שומרים את כל תוצאות החיפוש
   * לצורך בדיקה.
   */

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

  /*
   * עכשיו, ורק עכשיו,
   * מסננים את TVNetil בקוד.
   */

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

    /*
     * התאמה מלאה.
     */

    if (
      text.includes(wanted)
    ) {
      score += 300;
    }

    /*
     * התאמת מילים.
     */

    for (
      const word of words
    ) {
      if (
        text.includes(word)
      ) {
        score += 20;
      }
    }

    /*
     * אם אין אף מילה תואמת,
     * לא בוחרים את התוצאה.
     */

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

  /*
   * הכותרת נלקחת מתוצאת החיפוש
   * של TVNetil.
   */

  let title =
    cleanText(
      selected.title || ""
    );

  /*
   * מסירים את שם האתר אם הופיע
   * בכותרת.
   */

  title =
    title.replace(
      /\s*[-|–—]\s*TVNetil.*$/iu,
      ""
    );

  title =
    title.trim();

  return (
    title ||
    null
  );
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

      results: []
    };
  }

  /*
   * כאן מתחיל החיפוש השני.
   *
   * אנחנו שולחים למנוע החיפוש
   * את הכותרת שקיבלנו מתוצאת TVNetil.
   *
   * אין site:
   * אין -site:
   * אין מרכאות.
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

  /*
   * מוציאים תוצאות TVNetil
   * מהחיפוש השני.
   */

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

  return {
    query,

    resultCount:
      externalResults.length,

    results:
      externalResults
  };
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

  /*
   * בשלב הזה אנחנו בכוונה
   * מחזירים את כל התוצאות.
   *
   * לא בוחרים עדיין Stream באופן
   * עיוור.
   */

  return {
    success:
      secondSearch.results.length > 0,

    step:
      secondSearch.results.length > 0
        ? "results"
        : "external-search",

    hebrewTitle,

    firstSearch,

    tvnetilResult:
      selected,

    tvnetilTitle,

    secondSearch,

    /*
     * כרגע מציגים את התוצאות
     * ולא מחליטים לבד על קישור.
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
       * קודם כל metadata.
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
       * אחר כך שם עברי בלבד.
       */

      const hebrewTitle =
        getHebrewTitle(
          req,
          metadata
        );

      /*
       * אם אין עברית:
       * עוצרים מיד.
       *
       * אין חיפוש באנגלית.
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

       * 1. Hebrew title
       * 2. Search engine
       * 3. TVNetil result
       * 4. TVNetil result title
       * 5. Search engine
       * 6. Results
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
      "TVNetil Direct Streams 3.3.0"
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
      "TVNetil Direct Streams 3.3.0 started"
    );
  }
);

export default app;
