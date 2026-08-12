import express from "express";

const app = express();

const TVNETIL = "https://www.tvnetil.net";
const SERPER_API_KEY = process.env.SERPER_API_KEY;

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "2.6.0",
  name: "TVNetil Direct Streams",
  description: "Nuvio title -> Hebrew title -> TVNetil -> search -> stream",
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
    "SERPER:",
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
   GET METADATA
========================================================= */

async function getCinemetaMetadata(
  type,
  imdbId
) {
  const url =
    `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(imdbId)}.json`;

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Cinemeta HTTP ${response.status}`
    );
  }

  const json =
    await response.json();

  return (
    json?.meta ||
    json ||
    null
  );
}

/* =========================================================
   STEP 2
   GET TITLE
========================================================= */

function getMetadataTitle(meta) {
  const candidates = [
    meta?.name,
    meta?.title
  ];

  for (
    const value of candidates
  ) {
    if (!value) continue;

    const title =
      cleanText(value);

    if (title) {
      return title;
    }
  }

  return null;
}

/* =========================================================
   STEP 3
   RESOLVE HEBREW TITLE
========================================================= */

/*
   Cinemeta gives us the title belonging to
   the IMDb item.

   If the title is already Hebrew, use it.

   If Cinemeta gives English, we do NOT send
   that English title to TVNetil.

   Instead we use Serper to locate the Hebrew
   title for the SAME IMDb item.

   This is still before the TVNetil search.
*/

async function resolveHebrewTitle(
  imdbId,
  metadataTitle
) {
  /*
     First: title already supplied by metadata.
  */

  if (
    metadataTitle &&
    hasHebrew(metadataTitle)
  ) {
    return {
      title:
        metadataTitle,

      source:
        "metadata"
    };
  }

  /*
     Second: find the Hebrew title for
     the same IMDb ID.

     IMPORTANT:
     This is NOT the TVNetil search.

     It only resolves the Hebrew title.
  */

  const queries = [

    `"${imdbId}" "עברית"`,

    `"${metadataTitle || imdbId}" "עברית" סרט`,

    `"${metadataTitle || imdbId}" "he-IL"`,

    `"${metadataTitle || imdbId}" ישראל סרט`

  ];

  const candidates = [];

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
      candidates.push(
        ...data.organic
      );
    }
  }

  /*
     Search titles/snippets for Hebrew text.
  */

  for (
    const item of candidates
  ) {

    const text =
      cleanText(
        `${item.title || ""} ${item.snippet || ""}`
      );

    if (!hasHebrew(text)) {
      continue;
    }

    /*
       Try to extract a Hebrew title
       from the beginning of the result title.
    */

    const resultTitle =
      cleanText(
        item.title || ""
      );

    if (
      hasHebrew(resultTitle)
    ) {

      let title =
        resultTitle
          .replace(
            /\s*[-|–—]\s*(IMDb|TMDB|Google|ויקיפדיה).*$/iu,
            ""
          )
          .trim();

      /*
         Remove obvious prefixes.
      */

      title =
        title
          .replace(
            /^(סרט|הסרט|סדרה)\s*[:\-]\s*/u,
            ""
          )
          .trim();

      if (
        title &&
        hasHebrew(title)
      ) {

        return {
          title,
          source:
            "serper-hebrew-resolution"
        };
      }
    }
  }

  return null;
}

/* =========================================================
   STEP 4
   TVNETIL SEARCH
========================================================= */

async function searchTVNetil(
  hebrewTitle
) {
  /*
     HARD RULE:
     TVNetil receives Hebrew only.
  */

  if (
    !hebrewTitle ||
    !hasHebrew(hebrewTitle)
  ) {

    throw new Error(
      "TVNetil search requires a Hebrew title"
    );
  }

  const queries = [

    `site:tvnetil.net/review "${hebrewTitle}"`,

    `site:tvnetil.net/review ${hebrewTitle}`

  ];

  const results = [];

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

        results.push(item);
      }
    }
  }

  /*
     Remove duplicates.
  */

  const unique = [];
  const seen = new Set();

  for (
    const item of results
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
    normalize(hebrewTitle);

  let best =
    null;

  let bestScore =
    -1;

  for (
    const item of results
  ) {

    const text =
      normalize(
        `${item.title || ""} ${item.snippet || ""}`
      );

    let score =
      0;

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
   STEP 5
   GET TVNETIL RESULT TITLE
========================================================= */

async function getTVNetilTitle(
  result
) {

  /*
     First use Google's result title.
     This is the title of the TVNetil result.
  */

  let title =
    cleanText(
      result?.title || ""
    );

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

  /*
     If necessary open the TVNetil page.
  */

  const html =
    await getText(
      result.link
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
      cleanText(match[1]);

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
      cleanText(match[1]);

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
      cleanText(match[1]);

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
   STEP 6
   SEARCH ENGINE USING TVNETIL TITLE
========================================================= */

async function searchFinalLink(
  tvnetilTitle
) {

  if (!tvnetilTitle) {
    throw new Error(
      "TVNetil title is missing"
    );
  }

  /*
     THIS IS THE SECOND SEARCH.

     It uses the title that came FROM TVNetil.
  */

  const queries = [

    `"${tvnetilTitle}"`,

    `${tvnetilTitle}`

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
     Unique links.
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
     Pick result matching the TVNetil title.
  */

  const wanted =
    normalize(tvnetilTitle);

  let best =
    null;

  let bestScore =
    -1;

  for (
    const item of unique
  ) {

    const text =
      normalize(
        `${item.title || ""} ${item.snippet || ""}`
      );

    let score =
      0;

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
  type,
  imdbId
) {

  console.log(
    "======================================"
  );

  console.log(
    "IMDb:",
    imdbId
  );

  /*
     STEP 1
     Get the movie metadata/title.
  */

  const metadata =
    await getCinemetaMetadata(
      type,
      imdbId
    );

  const metadataTitle =
    getMetadataTitle(
      metadata
    );

  console.log(
    "Metadata title:",
    metadataTitle
  );

  if (!metadataTitle) {

    return {
      success: false,

      step:
        "metadata-title",

      imdbId,

      streams: []
    };
  }

  /*
     STEP 2
     Resolve the Hebrew title.
  */

  const hebrew =
    await resolveHebrewTitle(
      imdbId,
      metadataTitle
    );

  if (!hebrew?.title) {

    return {
      success: false,

      step:
        "hebrew-title",

      imdbId,

      metadataTitle,

      message:
        "Could not resolve a Hebrew title.",

      streams: []
    };
  }

  const hebrewTitle =
    hebrew.title;

  console.log(
    "Hebrew title:",
    hebrewTitle
  );

  /*
     STEP 3
     SEARCH TVNETIL USING HEBREW TITLE.
  */

  const tvnetilResults =
    await searchTVNetil(
      hebrewTitle
    );

  console.log(
    "TVNetil results:",
    tvnetilResults.length
  );

  if (
    !tvnetilResults.length
  ) {

    return {
      success: false,

      step:
        "tvnetil-search",

      imdbId,

      metadataTitle,

      hebrewTitle,

      streams: []
    };
  }

  /*
     STEP 4
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

      imdbId,

      metadataTitle,

      hebrewTitle,

      streams: []
    };
  }

  console.log(
    "TVNetil URL:",
    selectedTVNetil.link
  );

  /*
     STEP 5
     Take title FROM TVNetil RESULT.
  */

  const tvnetilTitle =
    await getTVNetilTitle(
      selectedTVNetil
    );

  if (!tvnetilTitle) {

    return {
      success: false,

      step:
        "tvnetil-title",

      imdbId,

      metadataTitle,

      hebrewTitle,

      tvnetilUrl:
        selectedTVNetil.link,

      streams: []
    };
  }

  console.log(
    "TVNetil title:",
    tvnetilTitle
  );

  /*
     STEP 6
     SEARCH AGAIN.

     This search uses ONLY the title
     received from TVNetil.
  */

  const finalSearch =
    await searchFinalLink(
      tvnetilTitle
    );

  const finalResult =
    finalSearch.selected;

  if (!finalResult?.link) {

    return {
      success: false,

      step:
        "final-search",

      imdbId,

      metadataTitle,

      hebrewTitle,

      tvnetilTitle,

      tvnetilUrl:
        selectedTVNetil.link,

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
     STEP 7
     Return final link to Nuvio.
  */

  return {

    success: true,

    imdbId,

    metadataTitle,

    hebrewTitle,

    hebrewTitleSource:
      hebrew.source,

    tvnetilTitle,

    tvnetilUrl:
      selectedTVNetil.link,

    finalSearchTitle:
      tvnetilTitle,

    finalUrl:
      finalResult.link,

    finalSearchResult: {

      title:
        finalResult.title || null,

      snippet:
        finalResult.snippet || null,

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
          "Use ?q=שם הסרט"
      });
    }

    try {

      /*
         This endpoint is for testing
         the TVNetil Hebrew -> final search
         flow directly.
      */

      if (!hasHebrew(title)) {

        return res.json({

          success: false,

          step:
            "hebrew-title",

          inputTitle:
            title,

          message:
            "TVNetil test requires a Hebrew title."
        });
      }

      const tvnetilResults =
        await searchTVNetil(
          title
        );

      if (
        !tvnetilResults.length
      ) {

        return res.json({

          success: false,

          step:
            "tvnetil-search",

          inputTitle:
            title,

          streams: []
        });
      }

      const selected =
        chooseTVNetilResult(
          tvnetilResults,
          title
        );

      if (!selected) {

        return res.json({

          success: false,

          step:
            "tvnetil-selection",

          inputTitle:
            title,

          streams: []
        });
      }

      const tvnetilTitle =
        await getTVNetilTitle(
          selected
        );

      if (!tvnetilTitle) {

        return res.json({

          success: false,

          step:
            "tvnetil-title",

          inputTitle:
            title,

          tvnetilUrl:
            selected.link,

          streams: []
        });
      }

      const finalSearch =
        await searchFinalLink(
          tvnetilTitle
        );

      const finalResult =
        finalSearch.selected;

      return res.json({

        success:
          !!finalResult?.link,

        inputTitle:
          title,

        tvnetilTitle,

        tvnetilUrl:
          selected.link,

        finalSearchTitle:
          tvnetilTitle,

        finalUrl:
          finalResult?.link || null,

        finalSearchResult:
          finalResult || null,

        streams:
          finalResult?.link
            ? [
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
            : []
      });

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
         EXACT SAME PATH:
         /stream/:type/:id.json

         IMDb ID is used to identify the
         Nuvio/Cinemeta item.
      */

      const result =
        await resolveTVNetil(
          type,
          id
        );

      return res.json({

        streams:
          result.streams || [],

        tvnetil:
          result

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
      "TVNetil Direct Streams 2.6.0"
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
      "TVNetil Direct Streams 2.6.0 started"
    );
  }
);

export default app;
