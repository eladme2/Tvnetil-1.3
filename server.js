import express from "express";

const app = express();

const SERPER_API_KEY = process.env.SERPER_API_KEY;

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "3.1.0",
  name: "TVNetil Direct Streams",
  description:
    "Nuvio Hebrew title -> TVNetil -> result title -> search engine -> external stream",
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
  /*
     קודם כל title שמגיע בבקשה.
     חייב להיות בעברית.
  */

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

  /*
     fallback למטאדאטה.
     גם כאן מקבלים רק עברית.
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
   HEBREW TITLE -> SEARCH ENGINE
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
     חשוב:
     חיפוש רגיל בלבד.

     אין site:
     אין -site:
     אין קיצור דרך.
  */

  const query =
    `"${hebrewTitle}"`;

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
     עכשיו הסקרפר החזיר תוצאות.

     רק כאן אנחנו בודקים מי מהן
     באמת TVNetil.
  */

  const tvnetilResults =
    organic.filter(
      item => {
        const link =
          String(
            item?.link || ""
          ).toLowerCase();

        return (
          link.includes(
            "tvnetil.net/review/"
          )
        );
      }
    );

  return tvnetilResults;
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
       התאמה מלאה.
    */

    if (
      text.includes(wanted)
    ) {
      score += 300;
    }

    /*
       התאמת מילים.
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
       אם אין אפילו מילה אחת תואמת,
       לא מדובר בסרט המבוקש.
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
   TVNETIL RESULT TITLE
========================================================= */

function getTVNetilTitle(
  selected
) {
  /*
     הכותרת נלקחת ישירות מתוצאת
     החיפוש של TVNetil.

     אין חיפוש נוסף כאן.
  */

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
   STEP 4
   TVNETIL TITLE -> SEARCH ENGINE
========================================================= */

async function searchExternal(
  tvnetilTitle
) {
  if (!tvnetilTitle) {
    return {
      selected: null,
      results: []
    };
  }

  /*
     כאן משתמשים בדיוק בכותרת שקיבלנו
     מ-TVNetil.

     חיפוש רגיל בלבד.

     אין site:
     אין -site:
  */

  const query =
    `"${tvnetilTitle}"`;

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
     רק אחרי קבלת התוצאות
     מסננים TVNetil.
  */

  const externalResults =
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

  if (
    !externalResults.length
  ) {
    return {
      selected: null,
      results: []
    };
  }

  /*
     בחירת התוצאה המתאימה ביותר.
  */

  const wanted =
    normalize(
      tvnetilTitle
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
    const item of externalResults
  ) {
    const text =
      normalize(
        `${item.title || ""} ${item.snippet || ""}`
      );

    let score = 0;

    /*
       התאמה מלאה של הכותרת.
    */

    if (
      text.includes(wanted)
    ) {
      score += 300;
    }

    /*
       התאמת מילים.
    */

    for (
      const word of words
    ) {
      if (
        text.includes(word)
      ) {
        score += 10;
      }
    }

    /*
       תוצאה שאין לה שום קשר לכותרת
       לא מתקבלת.
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

  return {
    selected:
      best,

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
    "STEP 1 - HEBREW TITLE:",
    hebrewTitle
  );

  /*
     STEP 1
     שם עברי
     ->
     מנוע חיפוש
     ->
     תוצאות
     ->
     סינון TVNetil
  */

  const tvnetilResults =
    await searchTVNetil(
      hebrewTitle
    );

  console.log(
    "STEP 1 - TVNETIL RESULTS:",
    tvnetilResults.length
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
     STEP 2
     בחירת תוצאת TVNetil.
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

      streams: []
    };
  }

  console.log(
    "STEP 2 - TVNETIL URL:",
    selected.link
  );

  /*
     STEP 3
     לקיחת הכותרת של תוצאת TVNetil.
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

      tvnetilUrl:
        selected.link,

      streams: []
    };
  }

  console.log(
    "STEP 3 - TVNETIL RESULT TITLE:",
    tvnetilTitle
  );

  /*
     STEP 4
     הכותרת של TVNetil
     ->
     מנוע החיפוש
  */

  const externalSearch =
    await searchExternal(
      tvnetilTitle
    );

  const finalResult =
    externalSearch.selected;

  if (!finalResult?.link) {
    return {
      success: false,

      step:
        "external-search",

      hebrewTitle,

      tvnetilTitle,

      tvnetilUrl:
        selected.link,

      searchResults:
        externalSearch.results,

      streams: []
    };
  }

  console.log(
    "STEP 4 - EXTERNAL URL:",
    finalResult.link
  );

  /*
     STEP 5
     Stream.
  */

  return {
    success: true,

    hebrewTitle,

    tvnetilTitle,

    tvnetilUrl:
      selected.link,

    finalSearchTitle:
      tvnetilTitle,

    finalUrl:
      finalResult.link,

    finalSearchResult: {
      title:
        finalResult.title ||
        null,

      snippet:
        finalResult.snippet ||
        null,

      link:
        finalResult.link
    },

    streams: [
      {
        name:
          "TVNetil",

        title:
          tvnetilTitle,

        url:
          finalResult.link,

        type:
          "http"
      }
    ]
  };
}

/* =========================================================
   TEST
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
       English is disabled.
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
   הנתיב נשאר בדיוק כמו שקבענו
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
         Nuvio / Cinemeta metadata.
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
         כאן חייב להיות שם עברי.
      */

      const hebrewTitle =
        getHebrewTitle(
          req,
          metadata
        );

      /*
         אין עברית:
         עוצרים.
         לא מחפשים Creed באנגלית.
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
         הסדר הקבוע:

         Nuvio Hebrew title
         ->
         search engine
         ->
         TVNetil result
         ->
         TVNetil result title
         ->
         search engine
         ->
         external URL
         ->
         stream
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
      "TVNetil Direct Streams 3.1.0"
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
      "TVNetil Direct Streams 3.1.0 started"
    );
  }
);

export default app;
