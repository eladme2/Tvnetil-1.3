import express from "express";

const app = express();

const TVNETIL = "https://www.tvnetil.net";
const SERPER_API_KEY = process.env.SERPER_API_KEY;

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "2.7.0",
  name: "TVNetil Direct Streams",
  description: "Nuvio title -> TVNetil -> TVNetil result title -> search -> stream",
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

/* =========================================================
   SERPER
========================================================= */

async function serperSearch(query, num = 10) {
  if (!SERPER_API_KEY) {
    throw new Error("SERPER_API_KEY is missing");
  }

  console.log("SERPER SEARCH:", query);

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
   METADATA
========================================================= */

async function getMetadata(type, imdbId) {
  const url =
    `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(imdbId)}.json`;

  const data = await getJson(url);

  return data?.meta || data || null;
}

/* =========================================================
   GET TITLE
========================================================= */

/*
   IMPORTANT:

   We DO NOT translate.
   We DO NOT invent a Hebrew title.
   We DO NOT perform another search to create a title.

   We use the title supplied to this resolver.

   /stream can receive:
   ?title=שם הסרט

   If title is not supplied, Cinemeta's name is used only
   because the Stream protocol gives us the IMDb ID.
*/

function getInputTitle(req, metadata) {
  const queryTitle =
    String(
      req.query.title || ""
    ).trim();

  if (queryTitle) {
    return cleanText(queryTitle);
  }

  const metadataTitle =
    metadata?.name ||
    metadata?.title ||
    "";

  return cleanText(
    metadataTitle
  );
}

/* =========================================================
   STEP 1
   SEARCH TVNETIL USING THE INPUT TITLE
========================================================= */

async function searchTVNetil(inputTitle) {
  if (!inputTitle) {
    throw new Error(
      "Movie title is missing"
    );
  }

  /*
     This is the FIRST search.

     The title is passed exactly as received.

     No translation.
     No shortening.
     No Hebrew reconstruction.
  */

  const queries = [
    `site:tvnetil.net/review "${inputTitle}"`,
    `site:tvnetil.net/review ${inputTitle}`
  ];

  const allResults = [];

  for (const query of queries) {
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

        allResults.push(item);
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
  inputTitle
) {
  const wanted =
    normalize(inputTitle);

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
    const resultText =
      normalize(
        `${item.title || ""} ${item.snippet || ""}`
      );

    let score = 0;

    /*
       Exact complete input title.
    */

    if (
      resultText.includes(
        wanted
      )
    ) {
      score += 200;
    }

    /*
       Count matching words.
    */

    for (
      const word of words
    ) {
      if (
        resultText.includes(
          word
        )
      ) {
        score += 15;
      }
    }

    /*
       Review page bonus.
    */

    if (
      item.link?.includes(
        "tvnetil.net/review/"
      )
    ) {
      score += 20;
    }

    /*
       We do NOT accept a result that
       has absolutely no matching word.

       This prevents:
       Creed -> אבי ביטר
    */

    if (
      words.length > 0 &&
      !words.some(
        word =>
          resultText.includes(word)
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
   STEP 2
   GET TITLE OF THE SELECTED TVNETIL RESULT
========================================================= */

async function getTVNetilResultTitle(
  selected
) {
  /*
     First use the title supplied by
     Serper for the TVNetil result.

     This is the title of the result.
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
     Fallback:
     open the actual TVNetil page.
  */

  const html =
    await getText(
      selected.link
    );

  let match;

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
   SEARCH FINAL ENGINE USING TVNETIL TITLE
========================================================= */

async function searchFinalEngine(
  tvnetilTitle
) {
  if (!tvnetilTitle) {
    throw new Error(
      "TVNetil result title is missing"
    );
  }

  /*
     IMPORTANT:

     This is the SECOND search.

     The query here is ONLY the title
     obtained from the TVNetil result.
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

  /*
     Choose the result matching
     the TVNetil title.
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
    const item of unique
  ) {
    const text =
      normalize(
        `${item.title || ""} ${item.snippet || ""}`
      );

    let score = 0;

    if (
      text.includes(
        wanted
      )
    ) {
      score += 200;
    }

    for (
      const word of words
    ) {
      if (
        text.includes(
          word
        )
      ) {
        score += 10;
      }
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

  return {
    selected: best,
    results: unique
  };
}

/* =========================================================
   COMPLETE FLOW
========================================================= */

async function resolveTVNetil(
  inputTitle
) {
  console.log(
    "======================================"
  );

  console.log(
    "INPUT TITLE:",
    inputTitle
  );

  /*
     STEP 1
     Input title -> TVNetil
  */

  const tvnetilResults =
    await searchTVNetil(
      inputTitle
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
      step: "tvnetil-search",
      inputTitle,
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
      inputTitle
    );

  if (!selected) {
    return {
      success: false,
      step: "tvnetil-selection",
      inputTitle,
      results: tvnetilResults,
      streams: []
    };
  }

  console.log(
    "TVNETIL URL:",
    selected.link
  );

  /*
     STEP 3
     Get title FROM TVNetil result
  */

  const tvnetilTitle =
    await getTVNetilResultTitle(
      selected
    );

  if (!tvnetilTitle) {
    return {
      success: false,
      step: "tvnetil-result-title",
      inputTitle,
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
     STEP 4
     TVNetil title -> final search engine
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
      step: "final-search",
      inputTitle,
      tvnetilTitle,
      tvnetilUrl:
        selected.link,
      searchResults:
        finalSearch.results,
      streams: []
    };
  }

  console.log(
    "FINAL LINK:",
    finalResult.link
  );

  /*
     STEP 5
     Return final link to Nuvio
  */

  return {
    success: true,

    inputTitle,

    tvnetilTitle,

    tvnetilUrl:
      selected.link,

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
         Nuvio/Stremio gives the addon the
         IMDb ID.

         If a title is supplied in the request,
         THAT title is used directly.

         No translation.
         No generated Hebrew title.
         No extra title-resolution search.
      */

      let inputTitle =
        String(
          req.query.title || ""
        ).trim();

      let metadataTitle =
        null;

      /*
         Only if Nuvio did not supply ?title,
         obtain the item's title from Cinemeta.
      */

      if (!inputTitle) {
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

        inputTitle =
          metadataTitle;
      }

      if (!inputTitle) {
        return res.json({
          streams: [],
          tvnetil: {
            success: false,
            step:
              "input-title",
            imdbId:
              id,
            message:
              "No movie title was supplied."
          }
        });
      }

      console.log(
        "IMDb ID:",
        id
      );

      console.log(
        "INPUT TITLE:",
        inputTitle
      );

      /*
         EXACT ORDER:

         input title
         ->
         TVNetil search
         ->
         TVNetil result title
         ->
         final search
         ->
         final URL
         ->
         stream
      */

      const result =
        await resolveTVNetil(
          inputTitle
        );

      return res.json({
        streams:
          result.streams || [],

        tvnetil: {
          success:
            result.success,

          imdbId:
            id,

          metadataTitle,

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
      "TVNetil Direct Streams 2.7.0"
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
      "TVNetil Direct Streams 2.7.0 started"
    );
  }
);

export default app;
