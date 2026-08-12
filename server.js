import express from "express";

const app = express();

const TVNETIL = "https://www.tvnetil.net";
const SERPER_API_KEY = process.env.SERPER_API_KEY;

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "2.5.0",
  name: "TVNetil Direct Streams",
  description: "Nuvio Hebrew title -> TVNetil -> Search Engine -> Stream",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"]
};

/* =========================================================
   HTTP
========================================================= */

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
      `HTTP ${response.status}: ${text.slice(0, 300)}`
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
   STEP 1
   TVNETIL SEARCH USING HEBREW TITLE
========================================================= */

async function searchTVNetilHebrew(
  hebrewTitle
) {

  if (!hebrewTitle) {
    throw new Error(
      "Hebrew title is missing"
    );
  }

  /*
     HARD RULE:
     Never search TVNetil with English.
  */

  if (!hasHebrew(hebrewTitle)) {
    throw new Error(
      `TVNetil search rejected non-Hebrew title: ${hebrewTitle}`
    );
  }

  /*
     Keep Serper because direct TVNetil
     search is blocked.

     IMPORTANT:
     The actual search term is the
     Hebrew title received from Nuvio.
  */

  const queries = [

    `site:tvnetil.net/review "${hebrewTitle}"`,

    `site:tvnetil.net/review ${hebrewTitle}`

  ];

  const allResults = [];

  for (const query of queries) {

    const data =
      await serperSearch(
        query,
        10
      );

    if (
      Array.isArray(data.organic)
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

        allResults.push(item);
      }
    }
  }

  /*
     Remove duplicate links.
  */

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

  console.log(
    "TVNetil results:",
    unique.length
  );

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
    normalize(hebrewTitle);

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
       Exact title
    */

    if (
      text.includes(wanted)
    ) {
      score += 200;
    }

    /*
       Individual words
    */

    const words =
      wanted
        .split(" ")
        .filter(
          word =>
            word.length >= 2
        );

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
       Prefer TVNetil review pages.
    */

    if (
      item.link?.includes(
        "tvnetil.net/review/"
      )
    ) {
      score += 50;
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
   EXTRACT TVNETIL TITLE
========================================================= */

async function getTVNetilExactTitle(
  reviewUrl,
  searchResult
) {

  /*
     First try the title returned
     directly by the search engine.

     This is important because this is
     the actual title that was found
     on TVNetil.
  */

  const searchTitle =
    cleanText(
      searchResult?.title || ""
    );

  if (
    searchTitle &&
    hasHebrew(searchTitle)
  ) {

    /*
       Remove Google suffixes if present.
    */

    const cleaned =
      searchTitle
        .replace(
          /\s*[-|–—]\s*TVNetil.*$/iu,
          ""
        )
        .trim();

    if (cleaned) {
      return cleaned;
    }
  }

  /*
     If necessary, open the TVNetil page
     and extract its title.
  */

  const html =
    await getText(
      reviewUrl
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

    let title =
      cleanText(match[1]);

    title =
      title
        .replace(
          /\s*[-|–—]\s*TVNetil.*$/iu,
          ""
        )
        .trim();

    if (
      title &&
      hasHebrew(title)
    ) {
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

    const title =
      cleanText(match[1]);

    if (
      title &&
      hasHebrew(title)
    ) {
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

    let title =
      cleanText(match[1]);

    title =
      title
        .replace(
          /\s*[-|–—]\s*TVNetil.*$/iu,
          ""
        )
        .trim();

    if (
      title &&
      hasHebrew(title)
    ) {
      return title;
    }
  }

  return null;
}

/* =========================================================
   STEP 2
   SEARCH SEARCH ENGINE USING TVNETIL TITLE
========================================================= */

async function searchEngineForExactTitle(
  exactTVNetilTitle
) {

  if (!exactTVNetilTitle) {
    throw new Error(
      "TVNetil exact title is missing"
    );
  }

  /*
     IMPORTANT:
     This is a DIFFERENT search.

     The query is now the title obtained
     FROM TVNetil.
  */

  const queries = [

    `"${exactTVNetilTitle}"`,

    `${exactTVNetilTitle}`

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
      Array.isArray(data.organic)
    ) {

      allResults.push(
        ...data.organic
      );
    }
  }

  /*
     Remove duplicate URLs.
  */

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

  /*
     Prefer results whose title/snippet
     actually contains the TVNetil title.
  */

  const wanted =
    normalize(
      exactTVNetilTitle
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

    const words =
      wanted
        .split(" ")
        .filter(
          word =>
            word.length >= 2
        );

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
    results: unique,
    selected: best
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
    "STEP 1 - Hebrew title:",
    hebrewTitle
  );

  /*
     Never use English.
  */

  if (
    !hebrewTitle ||
    !hasHebrew(hebrewTitle)
  ) {

    return {
      success: false,

      step:
        "hebrew-title",

      inputTitle:
        hebrewTitle || null,

      message:
        "No Hebrew title. English fallback is disabled.",

      streams: []
    };
  }

  /*
     STEP 2
     Search TVNetil through Serper.
  */

  const tvnetilResults =
    await searchTVNetilHebrew(
      hebrewTitle
    );

  if (
    !tvnetilResults.length
  ) {

    return {
      success: false,

      step:
        "tvnetil-search",

      inputTitle:
        hebrewTitle,

      message:
        "No TVNetil result found.",

      streams: []
    };
  }

  /*
     STEP 3
     Select TVNetil result.
  */

  const selectedTVNetil =
    chooseTVNetilResult(
      tvnetilResults,
      hebrewTitle
    );

  if (!selectedTVNetil) {

    return {
      success: false,

      step:
        "tvnetil-selection",

      inputTitle:
        hebrewTitle,

      streams: []
    };
  }

  console.log(
    "TVNetil page:",
    selectedTVNetil.link
  );

  /*
     STEP 4
     Get EXACT title from TVNetil.
  */

  const exactTVNetilTitle =
    await getTVNetilExactTitle(
      selectedTVNetil.link,
      selectedTVNetil
    );

  if (!exactTVNetilTitle) {

    return {
      success: false,

      step:
        "tvnetil-title",

      inputTitle:
        hebrewTitle,

      reviewUrl:
        selectedTVNetil.link,

      streams: []
    };
  }

  console.log(
    "TVNetil exact title:",
    exactTVNetilTitle
  );

  /*
     STEP 5
     Search search engine using
     EXACT TVNetil title.
  */

  console.log(
    "STEP 2 - Search using TVNetil title"
  );

  const searchResult =
    await searchEngineForExactTitle(
      exactTVNetilTitle
    );

  const selectedSearch =
    searchResult.selected;

  if (!selectedSearch) {

    return {
      success: false,

      step:
        "final-search",

      inputTitle:
        hebrewTitle,

      tvnetilTitle:
        exactTVNetilTitle,

      reviewUrl:
        selectedTVNetil.link,

      searchResults:
        searchResult.results,

      streams: []
    };
  }

  console.log(
    "FINAL LINK:",
    selectedSearch.link
  );

  /*
     STEP 6
     Return the final link as Stream.
  */

  return {

    success: true,

    inputTitle:
      hebrewTitle,

    tvnetilTitle:
      exactTVNetilTitle,

    tvnetilUrl:
      selectedTVNetil.link,

    finalSearchTitle:
      exactTVNetilTitle,

    finalUrl:
      selectedSearch.link,

    finalSearchResult: {

      title:
        selectedSearch.title || null,

      snippet:
        selectedSearch.snippet || null,

      link:
        selectedSearch.link
    },

    streams: [

      {
        name:
          "TVNetil",

        title:
          exactTVNetilTitle,

        url:
          selectedSearch.link,

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
          "Use ?q=שם הסרט"
      });
    }

    /*
       English is forbidden.
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
          "Only Hebrew titles are allowed."
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
          error.message
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
         Get metadata from Cinemeta.
      */

      const metaResponse =
        await fetch(
          `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(id)}.json`
        );

      if (!metaResponse.ok) {

        throw new Error(
          `Cinemeta HTTP ${metaResponse.status}`
        );
      }

      const metaJson =
        await metaResponse.json();

      const data =
        metaJson?.meta ||
        metaJson;

      /*
         IMPORTANT:
         Only accept a Hebrew title.

         English is NEVER used for TVNetil.
      */

      const candidates = [

        data?.name,

        data?.title,

        data?.originalName,

        data?.originalTitle

      ];

      let hebrewTitle =
        null;

      for (
        const candidate of candidates
      ) {

        const value =
          cleanText(candidate);

        if (
          value &&
          hasHebrew(value)
        ) {

          hebrewTitle =
            value;

          break;
        }
      }

      console.log(
        "IMDb ID:",
        id
      );

      console.log(
        "Hebrew title:",
        hebrewTitle
      );

      /*
         NO ENGLISH FALLBACK.
      */

      if (!hebrewTitle) {

        return res.json({

          streams: [],

          tvnetil: {

            success: false,

            step:
              "hebrew-title",

            imdbId:
              id,

            message:
              "No Hebrew title available. English search is disabled."
          }
        });
      }

      /*
         COMPLETE FLOW:
         Hebrew title
         ->
         TVNetil
         ->
         TVNetil title
         ->
         Search engine
         ->
         final link
      */

      const result =
        await resolveTVNetil(
          hebrewTitle
        );

      return res.json({

        streams:
          result.streams || [],

        tvnetil: {

          imdbId:
            id,

          type,

          ...result
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
      "TVNetil Direct Streams 2.5.0"
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
      "TVNetil Direct Streams 2.5.0 started"
    );
  }
);

export default app;
