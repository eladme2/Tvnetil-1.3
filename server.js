import express from "express";

const app = express();

const SERPER_API_KEY = process.env.SERPER_API_KEY;

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "2.8.0",
  name: "TVNetil Direct Streams",
  description:
    "Nuvio Hebrew title -> TVNetil -> result title -> search -> stream",
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

async function getText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      "Accept":
        "text/html,application/xhtml+xml,application/xml,*/*",
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

  return text;
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

async function serperSearch(query, num = 10) {
  if (!SERPER_API_KEY) {
    throw new Error(
      "SERPER_API_KEY is missing"
    );
  }

  console.log(
    "SERPER SEARCH:",
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
   GET TITLE
========================================================= */

/*
   IMPORTANT:

   We do NOT translate.
   We do NOT search for a Hebrew title.
   We do NOT create a Hebrew title.

   We only accept a title that already contains
   Hebrew characters.

   If the title is English:
   STOP.
*/

function getHebrewTitle(
  req,
  metadata
) {
  /*
     If Nuvio supplies ?title=,
     use it exactly as supplied.
  */

  const requestTitle =
    String(
      req.query.title || ""
    ).trim();

  if (
    requestTitle &&
    hasHebrew(requestTitle)
  ) {
    return cleanText(
      requestTitle
    );
  }

  /*
     If ?title exists but is English,
     DO NOT replace it with another title.
  */

  if (
    requestTitle &&
    !hasHebrew(requestTitle)
  ) {
    return null;
  }

  /*
     Fallback to the metadata title.

     Again: only accept Hebrew.
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

  /*
     English title = no result.
  */

  return null;
}

/* =========================================================
   STEP 1
   HEBREW TITLE -> TVNETIL
========================================================= */

async function searchTVNetil(
  hebrewTitle
) {
  /*
     Safety check:
     TVNetil search is NEVER performed
     without a Hebrew title.
  */

  if (
    !hebrewTitle ||
    !hasHebrew(hebrewTitle)
  ) {
    return [];
  }

  /*
     The Hebrew title is used as received.

     No translation.
     No shortening.
     No alternative title.
  */

  const queries = [
    `site:tvnetil.net/review "${hebrewTitle}"`,
    `site:tvnetil.net/review ${hebrewTitle}`
  ];

  const allResults = [];

  for (
    const query of queries
  ) {
    const data =
      await serperSearch(
        query,
        10
      );

    if (
      Array.isArray(
        data.organic
      )
    ) {
      for (
        const item of data.organic
      ) {
        if (!item?.link) {
          continue;
        }

        if (
          !item.link.includes(
            "tvnetil.net/review/"
          )
        ) {
          continue;
        }

        allResults.push(
          item
        );
      }
    }
  }

  const unique = [];
  const seen = new Set();

  for (
    const item of allResults
  ) {
    if (
      seen.has(item.link)
    ) {
      continue;
    }

    seen.add(item.link);
    unique.push(item);
  }

  return unique;
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

    /*
       Exact title match.
    */

    if (
      text.includes(wanted)
    ) {
      score += 200;
    }

    /*
       Matching words.
    */

    for (
      const word of words
    ) {
      if (
        text.includes(word)
      ) {
        score += 15;
      }
    }

    /*
       Must contain at least one
       meaningful word from the Hebrew title.

       This prevents unrelated results
       such as "אבי ביטר" from being selected.
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
   STEP 2
   GET TITLE FROM TVNETIL RESULT
========================================================= */

async function getTVNetilResultTitle(
  selected
) {
  /*
     First use Serper's title for
     the TVNetil result.
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

  if (title) {
    return title;
  }

  /*
     Fallback: open TVNetil page.
  */

  const html =
    await getText(
      selected.link
    );

  let match;

  /*
     og:title
  */

  match =
    html.match(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
    );

  if (match) {
    title =
      cleanText(
        match[1]
      );

    title =
      title
        .replace(
          /\s*[-|–—]\s*TVNetil.*$/iu,
          ""
        )
        .trim();

    if (title) {
      return title;
    }
  }

  /*
     H1
  */

  match =
    html.match(
      /<h1[^>]*>([\s\S]*?)<\/h1>/i
    );

  if (match) {
    title =
      cleanText(
        match[1]
      );

    if (title) {
      return title;
    }
  }

  /*
     HTML title
  */

  match =
    html.match(
      /<title[^>]*>([\s\S]*?)<\/title>/i
    );

  if (match) {
    title =
      cleanText(
        match[1]
      );

    title =
      title
        .replace(
          /\s*[-|–—]\s*TVNetil.*$/iu,
          ""
        )
        .trim();

    if (title) {
      return title;
    }
  }

  return null;
}

/* =========================================================
   STEP 3
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
     THIS IS THE SECOND SEARCH.

     We use ONLY the title obtained
     from the TVNetil result.

     No IMDb.
     No original title.
     No Hebrew title.
  */

  const queries = [
    `"${tvnetilTitle}"`,
    tvnetilTitle
  ];

  const allResults = [];

  for (
    const query of queries
  ) {
    const data =
      await serperSearch(
        query,
        10
      );

    if (
      Array.isArray(
        data.organic
      )
    ) {
      allResults.push(
        ...data.organic
      );
    }
  }

  const unique = [];
  const seen = new Set();

  for (
    const item of allResults
  ) {
    if (!item?.link) {
      continue;
    }

    if (
      seen.has(item.link)
    ) {
      continue;
    }

    seen.add(item.link);
    unique.push(item);
  }

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
    const item of unique
  ) {
    const text =
      normalize(
        `${item.title || ""} ${item.snippet || ""}`
      );

    let score = 0;

    if (
      text.includes(wanted)
    ) {
      score += 200;
    }

    for (
      const word of words
    ) {
      if (
        text.includes(word)
      ) {
        score += 10;
      }
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
      unique
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
    "HEBREW TITLE FROM NUVIO:",
    hebrewTitle
  );

  /*
     STEP 1:
     Hebrew title -> TVNetil
  */

  const tvnetilResults =
    await searchTVNetil(
      hebrewTitle
    );

  console.log(
    "TVNETIL RESULTS:",
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
     STEP 2:
     Choose TVNetil result
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

      results:
        tvnetilResults,

      streams: []
    };
  }

  console.log(
    "TVNETIL URL:",
    selected.link
  );

  /*
     STEP 3:
     Get title from TVNetil result
  */

  const tvnetilTitle =
    await getTVNetilResultTitle(
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
    "TVNETIL RESULT TITLE:",
    tvnetilTitle
  );

  /*
     STEP 4:
     TVNetil title -> search engine
  */

  const finalSearch =
    await searchFinalEngine(
      tvnetilTitle
    );

  const finalResult =
    finalSearch.selected;

  if (!finalResult?.link) {
    return {
      success: false,

      step:
        "final-search",

      hebrewTitle,

      tvnetilTitle,

      tvnetilUrl:
        selected.link,

      searchResults:
        finalSearch.results,

      streams: []
    };
  }

  console.log(
    "FINAL URL:",
    finalResult.link
  );

  /*
     STEP 5:
     Return stream
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
       Test endpoint also refuses English.
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
          "No Hebrew title. Search disabled.",

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
      /*
         Get metadata only to obtain the title
         that Nuvio/Cinemeta associates with
         this IMDb ID.

         IMPORTANT:
         We DO NOT translate it.
         We DO NOT search for a Hebrew title.
      */

      const metadata =
        await getMetadata(
          type,
          id
        );

      const hebrewTitle =
        getHebrewTitle(
          req,
          metadata
        );

      /*
         NO HEBREW TITLE =
         NO SEARCH AT ALL.
      */

      if (!hebrewTitle) {
        return res.json({
          streams: [],

          tvnetil: {
            success: false,

            imdbId:
              id,

            metadataTitle:
              cleanText(
                metadata?.name ||
                metadata?.title ||
                ""
              ),

            step:
              "hebrew-title",

            message:
              "No Hebrew title available. English search is disabled."
          }
        });
      }

      /*
         Exact required flow:

         Hebrew title
         ->
         TVNetil
         ->
         TVNetil result title
         ->
         search engine
         ->
         final link
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

          success:
            result.success,

          imdbId:
            id,

          metadataTitle:
            cleanText(
              metadata?.name ||
              metadata?.title ||
              ""
            )
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
      "TVNetil Direct Streams 2.8.0"
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
      "TVNetil Direct Streams 2.8.0 started"
    );
  }
);

export default app;
