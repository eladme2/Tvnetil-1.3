import express from "express";

const app = express();

const TVNETIL = "https://www.tvnetil.net";
const TVNETIL_API = "https://tvnetil-addon.vercel.app";

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "2.2.0",
  name: "TVNetil Direct Streams",
  description: "Nuvio Hebrew title -> TVNetil page -> exact page title",
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
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
      "Accept":
        "text/html,application/xhtml+xml,application/xml,application/json,*/*",
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

async function getJson(url) {
  const text = await getText(url, {
    headers: {
      "Accept": "application/json"
    }
  });

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Invalid JSON: ${text.slice(0, 500)}`
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
    .replace(
      /&#(\d+);/g,
      (_, n) => String.fromCharCode(Number(n))
    )
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, n) => String.fromCharCode(parseInt(n, 16))
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
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* =========================================================
   TVNETIL CATALOG
========================================================= */

async function getCatalog(type, skip = 0) {
  const catalog =
    type === "series"
      ? "tvnetil_series"
      : "tvnetil_movies";

  const url =
    `${TVNETIL_API}/catalog/${type}/${catalog}.json?skip=${skip}`;

  console.log("CATALOG:", url);

  return await getJson(url);
}

async function findCatalogItem(type, query) {
  const wanted = normalize(query);

  for (
    let skip = 0;
    skip < 10000;
    skip += 100
  ) {
    let data;

    try {
      data = await getCatalog(type, skip);
    } catch (error) {
      console.error(
        "CATALOG ERROR:",
        error.message
      );
      break;
    }

    const metas =
      Array.isArray(data?.metas)
        ? data.metas
        : [];

    if (!metas.length) {
      break;
    }

    for (const item of metas) {
      const names = [
        item.name,
        item.title,
        item.originalName,
        item.originalTitle
      ]
        .filter(Boolean)
        .map(normalize);

      for (const name of names) {
        if (
          name === wanted ||
          name.includes(wanted) ||
          wanted.includes(name)
        ) {
          return item;
        }
      }
    }

    if (metas.length < 100) {
      break;
    }
  }

  return null;
}

/* =========================================================
   TVNETIL SEARCH
========================================================= */

function buildTVNetilSearchUrl(title) {
  return (
    `${TVNETIL}/search/term/?` +
    `search_term=${encodeURIComponent(title)}` +
    `&type=all&go=`
  );
}

/*
  חשוב:
  מבחינת הלוגיקה זה עדיין חיפוש TVNetil.

  אנחנו לא שולחים את שם הסרט ישירות לשלב הבא.
  קודם חייבים למצוא את דף הסרט.
*/

async function fetchTVNetilSearch(title) {
  const target =
    buildTVNetilSearchUrl(title);

  console.log(
    "TVNETIL SEARCH:",
    target
  );

  /*
     ניסיון ראשון:
     גישה רגילה.
  */

  try {
    const html =
      await getText(target);

    return {
      html,
      url: target,
      method: "direct"
    };
  } catch (error) {

    console.log(
      "DIRECT TVNETIL FAILED:",
      error.message
    );
  }

  /*
     אם TVNetil מחזיר Cloudflare 403,
     אנחנו לא משנים את החיפוש.
     רק משתמשים ב-fetcher ציבורי כדי לקרוא
     את אותו URL.
  */

  const readerUrl =
    `https://r.jina.ai/http://${target.replace(
      /^https?:\/\//i,
      ""
    )}`;

  console.log(
    "TVNETIL READER:",
    readerUrl
  );

  const html =
    await getText(readerUrl, {
      headers: {
        "Accept": "text/plain,text/html,*/*"
      }
    });

  return {
    html,
    url: target,
    method: "reader"
  };
}

/* =========================================================
   REVIEW LINKS
========================================================= */

function extractReviewCandidates(html) {
  const results = [];

  /*
     HTML links
  */

  const linkRegex =
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while (
    (match = linkRegex.exec(html)) !== null
  ) {
    let href =
      decodeHtml(match[1])
        .replace(/[\r\n\t]/g, "")
        .trim();

    const text =
      cleanText(match[2]);

    if (!href || !text) {
      continue;
    }

    if (
      href.startsWith("/")
    ) {
      href =
        `${TVNETIL}${href}`;
    }

    if (
      href.includes("/review/")
    ) {
      results.push({
        url: href,
        text
      });
    }
  }

  /*
     Markdown links.
     Jina Reader עשוי להחזיר את הדף בפורמט Markdown.
  */

  const markdownRegex =
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi;

  while (
    (match =
      markdownRegex.exec(html)) !== null
  ) {
    const text =
      cleanText(match[1]);

    const href =
      decodeHtml(match[2]);

    if (
      href.includes("/review/")
    ) {
      results.push({
        url: href,
        text
      });
    }
  }

  /*
     URLs גולמיים
  */

  const urlRegex =
    /https?:\/\/[^\s"'<>]+\/review\/[^\s"'<>]+/gi;

  while (
    (match =
      urlRegex.exec(html)) !== null
  ) {
    results.push({
      url: match[0],
      text: ""
    });
  }

  const unique = [];
  const seen = new Set();

  for (const item of results) {
    if (!seen.has(item.url)) {
      seen.add(item.url);
      unique.push(item);
    }
  }

  return unique;
}

/* =========================================================
   MATCH TVNETIL RESULT
========================================================= */

function findBestReview(
  candidates,
  requestedTitle
) {
  const wanted =
    normalize(requestedTitle);

  let best = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const text =
      normalize(candidate.text);

    let score = 0;

    if (text === wanted) {
      score = 100;
    } else if (
      text.includes(wanted)
    ) {
      score = 95;
    } else if (
      wanted.includes(text) &&
      text.length >= 2
    ) {
      score = 90;
    } else {
      const wantedWords =
        wanted
          .split(" ")
          .filter(x => x.length >= 2);

      if (wantedWords.length) {
        let matched = 0;

        for (const word of wantedWords) {
          if (text.includes(word)) {
            matched++;
          }
        }

        score =
          Math.round(
            matched /
            wantedWords.length *
            80
          );
      }
    }

    if (score > bestScore) {
      bestScore = score;

      best = {
        ...candidate,
        score
      };
    }
  }

  return best;
}

/* =========================================================
   PAGE TITLE
========================================================= */

function extractPageTitle(html) {

  /*
     H1
  */

  let match =
    html.match(
      /<h1\b[^>]*>([\s\S]*?)<\/h1>/i
    );

  if (match) {
    const title =
      cleanText(match[1]);

    if (title) {
      return title;
    }
  }

  /*
     og:title
  */

  match =
    html.match(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
    );

  if (match) {
    const title =
      cleanText(match[1]);

    if (title) {
      return title;
    }
  }

  /*
     title
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
        .replace(
          /\s*[-|–—]\s*TVNet.*$/iu,
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
   OPEN TVNETIL MOVIE PAGE
========================================================= */

async function openTVNetilPage(url) {

  try {
    const html =
      await getText(url);

    return {
      html,
      method: "direct"
    };

  } catch (error) {

    console.log(
      "DIRECT PAGE FAILED:",
      error.message
    );
  }

  const readerUrl =
    `https://r.jina.ai/http://${url.replace(
      /^https?:\/\//i,
      ""
    )}`;

  const html =
    await getText(readerUrl);

  return {
    html,
    method: "reader"
  };
}

/* =========================================================
   COMPLETE TVNETIL FLOW
========================================================= */

async function findTVNetilPage(
  title,
  type
) {
  /*
     1.
     השם שמגיע מנוביו
  */

  console.log(
    "INPUT TITLE:",
    title
  );

  /*
     2.
     חיפוש TVNetil לפי השם
  */

  const search =
    await fetchTVNetilSearch(
      title
    );

  /*
     3.
     איתור דפי review
  */

  const candidates =
    extractReviewCandidates(
      search.html
    );

  console.log(
    "TVNETIL CANDIDATES:",
    candidates.length
  );

  if (!candidates.length) {
    return {
      success: false,
      step:
        "tvnetil-review-links",
      searchUrl:
        search.url,
      candidates: []
    };
  }

  /*
     4.
     בחירת דף הסרט המתאים
  */

  const best =
    findBestReview(
      candidates,
      title
    );

  if (
    !best ||
    best.score < 55
  ) {
    return {
      success: false,
      step:
        "tvnetil-match",
      searchUrl:
        search.url,
      candidates:
        candidates.slice(0, 30)
    };
  }

  console.log(
    "TVNETIL PAGE:",
    best.url
  );

  /*
     5.
     פתיחת דף הסרט
  */

  const page =
    await openTVNetilPage(
      best.url
    );

  /*
     6.
     הכותרת נלקחת מדף הסרט עצמו
  */

  const exactTitle =
    extractPageTitle(
      page.html
    );

  if (!exactTitle) {
    return {
      success: false,
      step:
        "tvnetil-page-title",
      searchUrl:
        search.url,
      reviewUrl:
        best.url
    };
  }

  console.log(
    "EXACT TVNETIL PAGE TITLE:",
    exactTitle
  );

  return {
    success: true,

    inputTitle:
      title,

    searchUrl:
      search.url,

    reviewUrl:
      best.url,

    exactPageTitle:
      exactTitle,

    fetchMethod:
      page.method
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

    const type =
      req.query.type === "series"
        ? "series"
        : "movie";

    if (!title) {
      return res.json({
        success: false,
        message:
          "Use ?q=שם הסרט"
      });
    }

    try {

      const result =
        await findTVNetilPage(
          title,
          type
        );

      return res.json({
        success:
          result.success,

        input: {
          titleFromNuvio:
            title,

          type
        },

        tvnetil:
          result
      });

    } catch (error) {

      console.error(
        "TEST ERROR:",
        error.stack ||
        error.message
      );

      return res.status(500).json({
        success: false,
        error:
          error.stack ||
          error.message
      });
    }
  }
);

/* =========================================================
   SEARCH TVNETIL
========================================================= */

app.get(
  "/search-tvnetil",
  async (req, res) => {

    const title =
      String(
        req.query.q || ""
      ).trim();

    const type =
      req.query.type === "series"
        ? "series"
        : "movie";

    if (!title) {
      return res.json({
        success: false,
        message:
          "Use ?q=שם הסרט"
      });
    }

    try {

      const result =
        await findTVNetilPage(
          title,
          type
        );

      return res.json(result);

    } catch (error) {

      return res.status(500).json({
        success: false,
        error:
          error.stack ||
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

    const type =
      req.params.type === "series"
        ? "series"
        : "movie";

    const id =
      String(
        req.params.id || ""
      ).trim();

    if (!id) {
      return res.json({
        streams: []
      });
    }

    try {

      /*
         Nuvio -> Cinemeta metadata
         לצורך קבלת שם הסרט בלבד.
      */

      const metaUrl =
        `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(id)}.json`;

      const meta =
        await getJson(
          metaUrl
        );

      const data =
        meta?.meta || meta;

      const titles = [
        data?.name,
        data?.title,
        data?.originalName,
        data?.originalTitle
      ]
        .filter(Boolean);

      /*
         =====================================================
         השלב החשוב:
         השם משמש לחיפוש TVNetil.
         =====================================================
      */

      let tvnetil = null;

      for (const title of titles) {

        try {

          const result =
            await findTVNetilPage(
              title,
              type
            );

          if (
            result.success &&
            result.exactPageTitle
          ) {
            tvnetil = result;
            break;
          }

        } catch (error) {

          console.error(
            "TVNETIL SEARCH ERROR:",
            error.message
          );
        }
      }

      if (
        !tvnetil ||
        !tvnetil.exactPageTitle
      ) {
        return res.json({
          streams: []
        });
      }

      /*
         כאן נעצרת גרסת הבדיקה.

         exactPageTitle הוא השם שנלקח
         מדף הסרט האמיתי ב-TVNetil.
      */

      console.log(
        "TVNETIL FINAL TITLE:",
        tvnetil.exactPageTitle
      );

      return res.json({
        streams: [],
        tvnetil: {
          reviewUrl:
            tvnetil.reviewUrl,

          exactPageTitle:
            tvnetil.exactPageTitle
        }
      });

    } catch (error) {

      console.error(
        "STREAM ERROR:",
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
      "TVNetil Direct Streams v2.2.0"
    );
  }
);

/* =========================================================
   VERCEL
========================================================= */

export default app;
