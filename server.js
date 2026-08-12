import express from "express";

const app = express();

const TVNETIL = "https://www.tvnetil.net";
const SERPER_API_KEY = process.env.SERPER_API_KEY;

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "2.3.0",
  name: "TVNetil Direct Streams",
  description: "Nuvio Hebrew title -> TVNetil exact movie page",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"]
};

async function getText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      "Accept":
        "text/html,application/xhtml+xml,application/xml,*/*",
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

/* =========================================================
   SERPER
========================================================= */

async function searchTVNetilWithSerper(title) {
  if (!SERPER_API_KEY) {
    throw new Error(
      "SERPER_API_KEY is missing"
    );
  }

  const queries = [
    `site:tvnetil.net/review "${title}"`,
    `site:tvnetil.net/review ${title}`
  ];

  const allResults = [];

  for (const q of queries) {
    const response = await fetch(
      "https://google.serper.dev/search",
      {
        method: "POST",

        headers: {
          "X-API-KEY": SERPER_API_KEY,
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          q,
          gl: "il",
          hl: "he",
          num: 10
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        `SERPER HTTP ${response.status}: ${JSON.stringify(data)}`
      );
    }

    allResults.push(
      ...(Array.isArray(data.organic)
        ? data.organic
        : [])
    );
  }

  const unique = [];
  const seen = new Set();

  for (const item of allResults) {
    if (!item?.link) continue;

    if (
      !item.link.includes(
        "tvnetil.net/review/"
      )
    ) {
      continue;
    }

    if (seen.has(item.link)) continue;

    seen.add(item.link);
    unique.push(item);
  }

  return unique;
}

/* =========================================================
   FIND REVIEW
========================================================= */

function normalize(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chooseReview(results, title) {
  const wanted = normalize(title);

  let best = null;
  let bestScore = -1;

  for (const item of results) {
    const text = normalize(
      `${item.title || ""} ${item.snippet || ""}`
    );

    let score = 0;

    if (text.includes(wanted)) {
      score += 100;
    }

    const words = wanted
      .split(" ")
      .filter(x => x.length >= 2);

    for (const word of words) {
      if (text.includes(word)) {
        score += 10;
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
   TVNETIL PAGE TITLE
========================================================= */

function extractExactTitle(html) {
  let match;

  match = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
  );

  if (match) {
    const title = cleanText(match[1]);

    if (title) return title;
  }

  match = html.match(
    /<h1[^>]*>([\s\S]*?)<\/h1>/i
  );

  if (match) {
    const title = cleanText(match[1]);

    if (title) return title;
  }

  match = html.match(
    /<title[^>]*>([\s\S]*?)<\/title>/i
  );

  if (match) {
    let title = cleanText(match[1]);

    title = title
      .replace(
        /\s*[-|–—]\s*TVNetil.*$/iu,
        ""
      )
      .trim();

    if (title) return title;
  }

  return null;
}

/* =========================================================
   COMPLETE FLOW
========================================================= */

async function resolveTVNetil(title) {
  console.log(
    "Nuvio title:",
    title
  );

  /*
   1. השם שמגיע מנוביו
  */

  const results =
    await searchTVNetilWithSerper(
      title
    );

  console.log(
    "TVNetil results:",
    results.length
  );

  if (!results.length) {
    return {
      success: false,
      step: "serper",
      inputTitle: title,
      results: []
    };
  }

  /*
   2. בחירת דף הסרט
  */

  const selected =
    chooseReview(
      results,
      title
    );

  if (!selected) {
    return {
      success: false,
      step: "review-selection",
      inputTitle: title,
      results
    };
  }

  const reviewUrl =
    selected.link;

  console.log(
    "TVNetil review:",
    reviewUrl
  );

  /*
   3. פתיחת דף הסרט
  */

  const html =
    await getText(
      reviewUrl
    );

  /*
   4. הכותרת נלקחת מדף הסרט עצמו
  */

  const exactPageTitle =
    extractExactTitle(html);

  if (!exactPageTitle) {
    return {
      success: false,
      step: "page-title",
      inputTitle: title,
      reviewUrl
    };
  }

  console.log(
    "Exact TVNetil title:",
    exactPageTitle
  );

  return {
    success: true,

    inputTitle:
      title,

    reviewUrl,

    exactPageTitle,

    serperResult: {
      title:
        selected.title || null,

      snippet:
        selected.snippet || null
    }
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
       מקבלים את שם הסרט מהמטאדאטה
       של Nuvio/Cinemeta.
      */

      const metaResponse =
        await fetch(
          `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(id)}.json`
        );

      const meta =
        await metaResponse.json();

      const data =
        meta?.meta || meta;

      const title =
        data?.name ||
        data?.title ||
        data?.originalName ||
        data?.originalTitle;

      if (!title) {
        return res.json({
          streams: []
        });
      }

      /*
       אותה זרימה בדיוק:
       שם → TVNetil → דף → כותרת.
      */

      const result =
        await resolveTVNetil(
          title
        );

      /*
       בשלב הזה אנחנו רק מחזירים
       את תוצאת המקור לבדיקה.
      */

      return res.json({
        streams: [],

        tvnetil: result
      });

    } catch (error) {

      console.error(
        error.stack ||
        error.message
      );

      return res.json({
        streams: []
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
      "TVNetil Direct Streams 2.3.0"
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
      "TVNetil Direct Streams 2.3.0 started"
    );
  }
);

export default app;
