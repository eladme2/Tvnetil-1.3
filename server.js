import express from "express";

const app = express();

const SERPER_API_KEY = process.env.SERPER_API_KEY;

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "2.9.0",
  name: "TVNetil Direct Streams",
  description:
    "Nuvio Hebrew title -> TVNetil -> result title -> external search -> stream",
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
   HEBREW TITLE
========================================================= */

function getHebrewTitle(
  req,
  metadata
) {
  /*
     If Nuvio/request supplies ?title,
     use it exactly.

     No translation.
     No title generation.
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
     If an explicit title was supplied
     but it is English, stop.
  */

  if (
    requestTitle &&
    !hasHebrew(requestTitle)
  ) {
    return null;
  }

  /*
     Fallback metadata.

     Only accept Hebrew.
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
   HEBREW TITLE -> TVNETIL
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
     First search.

     EXACT Hebrew title.
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
        score += 15;
      }
    }

    /*
       Reject completely unrelated TVNetil results.
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
   TVNETIL RESULT TITLE
========================================================= */

async function getTVNetilResultTitle(
  selected
) {
  /*
     Prefer the title returned by Serper.
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

  return null;
}

/* =========================================================
   STEP 2
   TVNETIL TITLE -> EXTERNAL SEARCH
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
     IMPORTANT:

     This is the SECOND search.

     TVNetil itself is explicitly excluded.

     We search using ONLY the title
     obtained from the TVNetil result.
  */

  const query =
    `"${tvnetilTitle}" -site:tvnetil.net`;

  const data =
    await serperSearch(
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
     Extra protection:
     remove every TVNetil result even if
     Serper ignores the exclusion.
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

  if (!results.length) {
    return {
      selected: null,
      results: []
    };
  }

  /*
     Match the TVNetil title.

     We don't simply take result #1.
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
    const item of results
  ) {
    const text =
      normalize(
        `${item.title || ""} ${item.snippet || ""}`
      );

    let score = 0;

    /*
       Exact complete title.
    */

    if (
      text.includes(wanted)
    ) {
      score += 300;
    }

    /*
       Individual title words.
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
       Do not accept a result with
       zero matching words.
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

    results
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
    "HEBREW TITLE:",
    hebrewTitle
  );

  /*
     STEP 1
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
     STEP 2
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
     STEP 3
     Get title from TVNetil
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
    "TVNETIL TITLE:",
    tvnetilTitle
  );

  /*
     STEP 4
     TVNetil title -> external search
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
        "external-search",

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
    "EXTERNAL URL:",
    finalResult.link
  );

  /*
     STEP 5
     Return final external URL
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
       English is never searched.
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
      /*
         Get metadata only.

         We NEVER translate an English title.
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

      /*
         No Hebrew title =
         no search whatsoever.
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
         EXACT FLOW:

         Hebrew title
         ->
         TVNetil
         ->
         TVNetil result title
         ->
         external search
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
      "TVNetil Direct Streams 2.9.0"
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
      "TVNetil Direct Streams 2.9.0 started"
    );
  }
);

export default app;
