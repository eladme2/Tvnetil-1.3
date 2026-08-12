import express from "express";

const app = express();

const SERPER_API_KEY = process.env.SERPER_API_KEY;

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "3.6.0",
  name: "TVNetil Direct Streams",
  description:
    "Nuvio Hebrew title -> TVNetil page -> exact TVNetil title -> PixelDrain/GoFile",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"]
};

/* =========================================================
   HTTP
========================================================= */

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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

  return text;
}

async function getJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      Accept: "application/json,text/plain,*/*",
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
    throw new Error("SERPER_API_KEY is missing");
  }

  console.log("======================================");
  console.log("SERPER QUERY:", query);

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
   CINEMETA
========================================================= */

async function getMetadata(type, imdbId) {
  const url =
    `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(imdbId)}.json`;

  const data = await getJson(url);

  return data?.meta || data || null;
}

/* =========================================================
   HEBREW TITLE
========================================================= */

function getHebrewTitle(req, metadata) {
  const requestTitle =
    String(req.query.title || "").trim();

  if (requestTitle) {
    if (!hasHebrew(requestTitle)) {
      return null;
    }

    return cleanText(requestTitle);
  }

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
   HEBREW TITLE -> TVNETIL SEARCH
========================================================= */

async function searchTVNetil(hebrewTitle) {
  const query =
    `${hebrewTitle} TVNetil`;

  const data =
    await serperSearch(query, 20);

  const organic =
    Array.isArray(data?.organic)
      ? data.organic
      : [];

  const allSearchResults =
    organic.map(item => ({
      title: item?.title || null,
      link: item?.link || null,
      snippet: item?.snippet || null,
      date: item?.date || null,
      position: item?.position || null
    }));

  const tvnetilResults =
    allSearchResults.filter(item => {
      const link =
        String(item.link || "").toLowerCase();

      return link.includes(
        "tvnetil.net/review/"
      );
    });

  return {
    query,
    resultCount:
      tvnetilResults.length,
    results:
      tvnetilResults,
    allSearchResults
  };
}

/* =========================================================
   STEP 2
   CHOOSE TVNETIL PAGE
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
      .filter(word =>
        word.length >= 2
      );

  let best = null;
  let bestScore = -1;

  for (const item of results) {
    const text =
      normalize(
        `${item.title || ""} ${item.snippet || ""}`
      );

    let score = 0;

    if (text.includes(wanted)) {
      score += 300;
    }

    for (const word of words) {
      if (text.includes(word)) {
        score += 20;
      }
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
   OPEN TVNETIL PAGE
   AND EXTRACT REAL PAGE TITLE
========================================================= */

function extractPageTitle(html) {
  const candidates = [];

  /* <title> */
  const titleMatch =
    html.match(
      /<title[^>]*>([\s\S]*?)<\/title>/i
    );

  if (titleMatch?.[1]) {
    candidates.push(
      cleanText(titleMatch[1])
    );
  }

  /* og:title */
  const ogTitleMatch =
    html.match(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
    );

  if (ogTitleMatch?.[1]) {
    candidates.push(
      cleanText(ogTitleMatch[1])
    );
  }

  /* reverse attribute order */
  const ogTitleMatch2 =
    html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i
    );

  if (ogTitleMatch2?.[1]) {
    candidates.push(
      cleanText(ogTitleMatch2[1])
    );
  }

  /* h1 */
  const h1Match =
    html.match(
      /<h1[^>]*>([\s\S]*?)<\/h1>/i
    );

  if (h1Match?.[1]) {
    candidates.push(
      cleanText(h1Match[1])
    );
  }

  /*
   * מעדיפים כותרת שמכילה עברית.
   */
  const hebrewCandidate =
    candidates.find(candidate =>
      hasHebrew(candidate)
    );

  return (
    hebrewCandidate ||
    candidates.find(Boolean) ||
    null
  );
}

function cleanTVNetilPageTitle(title) {
  let result =
    cleanText(title);

  /*
   * הסרת שם האתר אם הוא מופיע בכותרת
   */
  result =
    result.replace(
      /\s*[-|–—]\s*TVNetil(?:\.net)?\s*$/iu,
      ""
    );

  result =
    result.replace(
      /^\s*TVNetil(?:\.net)?\s*[-|–—]\s*/iu,
      ""
    );

  return result.trim();
}

async function getRealTVNetilTitle(selected) {
  if (!selected?.link) {
    return {
      title: null,
      pageUrl: null,
      error: "TVNetil result has no link"
    };
  }

  console.log(
    "OPEN TVNETIL PAGE:",
    selected.link
  );

  try {
    const html =
      await fetchText(
        selected.link
      );

    const rawTitle =
      extractPageTitle(html);

    const realTitle =
      cleanTVNetilPageTitle(
        rawTitle
      );

    console.log(
      "TVNETIL PAGE RAW TITLE:",
      rawTitle
    );

    console.log(
      "TVNETIL REAL TITLE:",
      realTitle
    );

    return {
      title:
        realTitle || null,
      rawTitle:
        rawTitle || null,
      pageUrl:
        selected.link,
      error: null
    };

  } catch (error) {
    console.error(
      "TVNETIL PAGE ERROR:",
      error.message
    );

    return {
      title: null,
      rawTitle: null,
      pageUrl: selected.link,
      error: error.message
    };
  }
}

/* =========================================================
   STEP 4
   EXTERNAL SEARCH USING
   THE REAL TVNETIL PAGE TITLE
========================================================= */

async function searchExternal(tvnetilTitle) {
  if (!tvnetilTitle) {
    return {
      query: null,
      resultCount: 0,
      results: []
    };
  }

  const query =
    `"${tvnetilTitle}"`;

  const data =
    await serperSearch(
      query,
      20
    );

  const organic =
    Array.isArray(data?.organic)
      ? data.organic
      : [];

  const results =
    organic.map(item => ({
      title: item?.title || null,
      link: item?.link || null,
      snippet: item?.snippet || null,
      date: item?.date || null,
      position: item?.position || null
    }));

  return {
    query,
    resultCount:
      results.length,
    results
  };
}

/* =========================================================
   STEP 5
   PIXELDRAIN
========================================================= */

async function searchPixelDrain(tvnetilTitle) {
  if (!tvnetilTitle) {
    return {
      queries: [],
      resultCount: 0,
      results: []
    };
  }

  const queries = [
    `"${tvnetilTitle}" "pixeldrain.com"`,
    `"${tvnetilTitle}" PixelDrain`,
    `"${tvnetilTitle}" pixeldrain`,
    `site:pixeldrain.com "${tvnetilTitle}"`
  ];

  const collected = [];
  const seen = new Set();

  for (const query of queries) {
    try {
      const data =
        await serperSearch(
          query,
          20
        );

      const organic =
        Array.isArray(data?.organic)
          ? data.organic
          : [];

      for (const item of organic) {
        const result = {
          title:
            item?.title || null,
          link:
            item?.link || null,
          snippet:
            item?.snippet || null,
          date:
            item?.date || null,
          position:
            item?.position || null
        };

        const link =
          String(
            result.link || ""
          ).trim();

        if (!link) {
          continue;
        }

        const lower =
          link.toLowerCase();

        if (
          !lower.includes(
            "pixeldrain.com"
          )
        ) {
          continue;
        }

        if (seen.has(link)) {
          continue;
        }

        seen.add(link);
        collected.push(result);
      }

    } catch (error) {
      console.error(
        "PIXELDRAIN SEARCH ERROR:",
        error.message
      );
    }
  }

  return {
    queries,
    resultCount:
      collected.length,
    results:
      collected
  };
}

/* =========================================================
   STEP 6
   GOFILE
========================================================= */

async function searchGoFile(tvnetilTitle) {
  if (!tvnetilTitle) {
    return {
      queries: [],
      resultCount: 0,
      results: []
    };
  }

  const queries = [
    `"${tvnetilTitle}" "gofile.io"`,
    `"${tvnetilTitle}" GoFile`,
    `site:gofile.io "${tvnetilTitle}"`
  ];

  const collected = [];
  const seen = new Set();

  for (const query of queries) {
    try {
      const data =
        await serperSearch(
          query,
          20
        );

      const organic =
        Array.isArray(data?.organic)
          ? data.organic
          : [];

      for (const item of organic) {
        const result = {
          title:
            item?.title || null,
          link:
            item?.link || null,
          snippet:
            item?.snippet || null,
          date:
            item?.date || null,
          position:
            item?.position || null
        };

        const link =
          String(
            result.link || ""
          ).trim();

        if (!link) {
          continue;
        }

        if (
          !link
            .toLowerCase()
            .includes("gofile.io")
        ) {
          continue;
        }

        if (seen.has(link)) {
          continue;
        }

        seen.add(link);
        collected.push(result);
      }

    } catch (error) {
      console.error(
        "GOFILE SEARCH ERROR:",
        error.message
      );
    }
  }

  return {
    queries,
    resultCount:
      collected.length,
    results:
      collected
  };
}

/* =========================================================
   STEP 7
   CONVERT SEARCH RESULTS TO STREAMS
========================================================= */

function extractStreams(
  pixelDrainSearch,
  goFileSearch
) {
  const streams = [];
  const seen = new Set();

  function addStream(
    item,
    provider
  ) {
    const link =
      String(
        item?.link || ""
      ).trim();

    if (!link) {
      return;
    }

    const lower =
      link.toLowerCase();

    let finalUrl =
      link;

    /*
     * PixelDrain:
     *
     * /u/FILEID
     * ->
     * /api/file/FILEID
     */
    if (
      provider === "PixelDrain" &&
      lower.includes(
        "pixeldrain.com/u/"
      )
    ) {
      const parts =
        link
          .split("/")
          .filter(Boolean);

      const id =
        parts[parts.length - 1];

      if (id) {
        finalUrl =
          `https://pixeldrain.com/api/file/${id}`;
      }
    }

    /*
     * לא משנים קישורי API קיימים
     */
    if (
      seen.has(finalUrl)
    ) {
      return;
    }

    seen.add(finalUrl);

    streams.push({
      name:
        provider,
      title:
        cleanText(
          item?.title ||
          provider
        ),
      url:
        finalUrl,
      type:
        "http"
    });
  }

  for (
    const item of
    pixelDrainSearch?.results || []
  ) {
    addStream(
      item,
      "PixelDrain"
    );
  }

  for (
    const item of
    goFileSearch?.results || []
  ) {
    addStream(
      item,
      "GoFile"
    );
  }

  return streams;
}

/* =========================================================
   COMPLETE FLOW
========================================================= */

async function resolveTVNetil(
  hebrewTitle
) {
  console.log("======================================");
  console.log("FLOW START");
  console.log(
    "HEBREW TITLE:",
    hebrewTitle
  );

  /* 1. Hebrew -> TVNetil */
  const firstSearch =
    await searchTVNetil(
      hebrewTitle
    );

  if (
    !firstSearch.results.length
  ) {
    return {
      success: false,
      step: "tvnetil-search",
      hebrewTitle,
      firstSearch,
      streams: []
    };
  }

  /* 2. Select TVNetil result */
  const selected =
    chooseTVNetilResult(
      firstSearch.results,
      hebrewTitle
    );

  if (!selected) {
    return {
      success: false,
      step: "tvnetil-selection",
      hebrewTitle,
      firstSearch,
      streams: []
    };
  }

  /* 3. IMPORTANT:
        OPEN THE ACTUAL TVNETIL PAGE
        AND GET ITS REAL TITLE
  */
  const pageData =
    await getRealTVNetilTitle(
      selected
    );

  if (!pageData.title) {
    return {
      success: false,
      step: "tvnetil-page-title",
      hebrewTitle,
      firstSearch,
      tvnetilResult:
        selected,
      tvnetilPage:
        pageData,
      streams: []
    };
  }

  const tvnetilTitle =
    pageData.title;

  console.log(
    "======================================"
  );

  console.log(
    "EXACT TVNETIL PAGE TITLE:",
    tvnetilTitle
  );

  /* 4. Search using exact page title */
  const secondSearch =
    await searchExternal(
      tvnetilTitle
    );

  /* 5. PixelDrain */
  const pixelDrainSearch =
    await searchPixelDrain(
      tvnetilTitle
    );

  /* 6. GoFile */
  const goFileSearch =
    await searchGoFile(
      tvnetilTitle
    );

  /* 7. Streams */
  const streams =
    extractStreams(
      pixelDrainSearch,
      goFileSearch
    );

  console.log(
    "PIXELDRAIN:",
    pixelDrainSearch.resultCount
  );

  console.log(
    "GOFILE:",
    goFileSearch.resultCount
  );

  console.log(
    "STREAMS:",
    streams.length
  );

  return {
    success:
      streams.length > 0,

    step:
      streams.length > 0
        ? "streams"
        : "results",

    hebrewTitle,

    firstSearch,

    tvnetilResult:
      selected,

    tvnetilPage:
      pageData,

    /*
     * זה השם שנלקח מהדף עצמו
     */
    tvnetilTitle,

    /*
     * תוצאות החיפוש שנעשו
     * עם השם המדויק מהדף
     */
    secondSearch,

    pixelDrainSearch,

    goFileSearch,

    streams
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

    if (!hasHebrew(title)) {
      return res.json({
        success: false,
        step: "hebrew-title",
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

      const result =
        await resolveTVNetil(
          hebrewTitle
        );

      return res.json({
        streams:
          result.streams || [],

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
      "TVNetil Direct Streams 3.6.0"
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
      "TVNetil Direct Streams 3.6.0 started"
    );
  }
);

export default app;
