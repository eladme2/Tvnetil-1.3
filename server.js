import express from "express";

const app = express();

const TVNETIL = "https://www.tvnetil.net";
const TVNETIL_API = "https://tvnetil-addon.vercel.app";
const FAVE = "https://www.favez0ne.net/search.php";

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "1.9.0",
  name: "TVNetil Direct Streams",
  description: "TVNetil exact TVNetil page title -> FaveZone streams",
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
      `Invalid JSON from ${url}: ${text.slice(0, 500)}`
    );
  }
}

/* =========================================================
   TEXT
========================================================= */

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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

function extractYear(value) {
  const match = String(value || "")
    .match(/\b(19|20)\d{2}\b/);

  return match ? Number(match[0]) : null;
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

  console.log(
    "TVNETIL CATALOG:",
    url
  );

  return await getJson(url);
}

/* =========================================================
   FIND REVIEW URL INSIDE CATALOG ITEM
========================================================= */

function findReviewUrlInObject(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  /*
     אנחנו מחפשים את כתובת דף הסרט עצמו.
     לא מחפשים את השם ולא מייצרים שם חדש.
  */

  const possibleValues = [
    item.url,
    item.link,
    item.href,
    item.webUrl,
    item.website,
    item.pageUrl,
    item.reviewUrl,
    item.review,
    item.externalUrl
  ];

  for (const value of possibleValues) {
    if (
      typeof value === "string" &&
      /\/review\/\d+\/?/i.test(value)
    ) {
      if (/^https?:\/\//i.test(value)) {
        return value;
      }

      if (value.startsWith("/")) {
        return `${TVNETIL}${value}`;
      }
    }
  }

  /*
     בדיקה רקורסיבית של אובייקטים פנימיים.
  */

  for (const value of Object.values(item)) {
    if (
      value &&
      typeof value === "object"
    ) {
      const result =
        findReviewUrlInObject(value);

      if (result) {
        return result;
      }
    }
  }

  return null;
}

/* =========================================================
   SEARCH CATALOG BY IMDb / TITLE
========================================================= */

async function findCatalogItem(
  type,
  imdbId,
  titles = [],
  maxPages = 100
) {
  const normalizedTitles =
    titles
      .filter(Boolean)
      .map(normalize);

  const wantedId =
    normalize(imdbId);

  for (
    let skip = 0;
    skip < maxPages * 100;
    skip += 100
  ) {
    let data;

    try {
      data =
        await getCatalog(
          type,
          skip
        );
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

    /*
       קודם כל התאמה לפי IMDb ID.
    */

    for (const item of metas) {
      const itemId =
        String(
          item.id ||
          item.imdb_id ||
          item.imdbId ||
          ""
        ).trim();

      if (
        wantedId &&
        normalize(itemId) === wantedId
      ) {
        console.log(
          "CATALOG IMDb MATCH:",
          itemId
        );

        return item;
      }
    }

    /*
       אם אין IMDb ID בקטלוג,
       מחפשים לפי שם.
    */

    for (const item of metas) {
      const itemNames = [
        item.name,
        item.title,
        item.originalName,
        item.originalTitle
      ]
        .filter(Boolean)
        .map(normalize);

      for (const wanted of normalizedTitles) {
        if (!wanted) {
          continue;
        }

        for (const name of itemNames) {
          if (
            name === wanted ||
            name.includes(wanted) ||
            wanted.includes(name)
          ) {
            console.log(
              "CATALOG TITLE MATCH:",
              name
            );

            return item;
          }
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
   EXTRACT EXACT TITLE FROM TVNETIL MOVIE PAGE
========================================================= */

function extractTVNetilTitle(html) {
  /*
     1. קודם כל title של הדף.
  */

  let match =
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

    if (
      title &&
      title.length >= 2
    ) {
      return title;
    }
  }

  /*
     2. h1
  */

  for (const tag of ["h1", "h2"]) {
    match =
      html.match(
        new RegExp(
          `<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,
          "i"
        )
      );

    if (match) {
      const title =
        cleanText(match[1]);

      if (
        title &&
        title.length >= 2
      ) {
        return title;
      }
    }
  }

  return null;
}

/* =========================================================
   OPEN TVNETIL MOVIE PAGE
========================================================= */

async function getTVNetilReview(url) {
  console.log(
    "OPENING TVNETIL MOVIE PAGE:",
    url
  );

  const html =
    await getText(url);

  const title =
    extractTVNetilTitle(html);

  console.log(
    "EXACT TVNETIL PAGE TITLE:",
    title
  );

  return {
    url,
    title,
    html
  };
}

/* =========================================================
   FAVEZONE SEARCH
========================================================= */

async function searchFavez0ne(title) {
  const body =
    new URLSearchParams({
      srch: title,
      "submit.x": "0",
      "submit.y": "0"
    }).toString();

  console.log(
    "FAVEZONE SEARCH TITLE:",
    title
  );

  return await getText(
    FAVE,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",

        "Referer":
          "https://www.favez0ne.net/",

        "Origin":
          "https://www.favez0ne.net",

        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },

      body
    }
  );
}

/* =========================================================
   FAVEZONE LINKS
========================================================= */

function extractFavezLinks(html) {
  const results = [];

  const hrefRegex =
    /href\s*=\s*["']([^"']+)["']/gi;

  let match;

  while (
    (match = hrefRegex.exec(html)) !== null
  ) {
    const url =
      decodeHtml(match[1])
        .replace(/[\r\n\t]/g, "")
        .trim();

    if (
      /^https?:\/\//i.test(url)
    ) {
      results.push(url);
    }
  }

  const directRegex =
    /https?:\/\/[^\s"'<>\\]+/gi;

  while (
    (match =
      directRegex.exec(html)) !== null
  ) {
    const url =
      decodeHtml(match[0])
        .replace(/[\r\n\t]/g, "")
        .replace(/[),.;]+$/, "")
        .trim();

    results.push(url);
  }

  const unique =
    [...new Set(results)];

  const allowed = [
    "pixeldrain.com",
    "gofile.io",
    "mega.nz",
    "1fichier.com",
    "send.now",
    "usersdrive.com",
    "usersdrive.net"
  ];

  return unique.filter(url => {
    try {
      const host =
        new URL(url)
          .hostname
          .toLowerCase();

      return allowed.some(
        domain =>
          host === domain ||
          host.endsWith(
            "." + domain
          )
      );
    } catch {
      return false;
    }
  });
}

/* =========================================================
   FAVE SEARCH
========================================================= */

async function searchFave(title) {
  const html =
    await searchFavez0ne(title);

  const links =
    extractFavezLinks(html);

  return {
    title,
    htmlLength: html.length,
    links
  };
}

/* =========================================================
   BUILD STREAMS
========================================================= */

function buildStreams(
  links,
  title,
  type,
  id
) {
  return links.map(
    url => ({
      name:
        `TVNetil • ${title}`,

      title:
        `צפייה ישירה • ${title}`,

      url,

      type:
        "url",

      behaviorHints: {
        bingeGroup:
          `tvnetil-${type}-${id}`,

        notWebReady:
          false
      }
    })
  );
}

/* =========================================================
   TEST BY TITLE
========================================================= */

app.get(
  "/test-title",
  async (req, res) => {
    const type =
      req.query.type === "series"
        ? "series"
        : "movie";

    const q =
      String(
        req.query.q || ""
      ).trim();

    if (!q) {
      return res.json({
        success: false,
        message:
          "Use ?q=שם הסרט"
      });
    }

    try {
      /*
         שלב 1:
         מוצאים את הסרט בקטלוג TVNetil.
      */

      const catalogItem =
        await findCatalogItem(
          type,
          "",
          [q]
        );

      if (!catalogItem) {
        return res.json({
          success: false,

          step:
            "tvnetil-catalog",

          query:
            q,

          message:
            "הסרט לא נמצא בקטלוג TVNetil"
        });
      }

      /*
         שלב 2:
         מוצאים את כתובת דף הסרט מתוך הקטלוג.
      */

      const reviewUrl =
        findReviewUrlInObject(
          catalogItem
        );

      if (!reviewUrl) {
        return res.json({
          success: false,

          step:
            "tvnetil-review-url",

          query:
            q,

          catalogItem,

          message:
            "הסרט נמצא בקטלוג, אבל לא נמצאה כתובת דף ה-Review של הסרט"
        });
      }

      /*
         שלב 3:
         נכנסים לדף הסרט עצמו.
      */

      const review =
        await getTVNetilReview(
          reviewUrl
        );

      if (!review.title) {
        return res.json({
          success: false,

          step:
            "tvnetil-page-title",

          reviewUrl,

          message:
            "דף הסרט נמצא אבל לא הצלחנו לחלץ ממנו את השם"
        });
      }

      /*
         שלב 4:
         ורק עכשיו שולחים ל-FaveZone
         את השם שהועתק מדף הסרט.
      */

      const fave =
        await searchFave(
          review.title
        );

      return res.json({
        success:
          fave.links.length > 0,

        flow: [
          "TVNetil catalog",
          "TVNetil movie page",
          "Exact title from TVNetil page",
          "FaveZone search"
        ],

        input: {
          query: q,
          type
        },

        tvnetil: {
          catalogItem,
          reviewUrl,
          exactPageTitle:
            review.title
        },

        favezone: {
          searchTitle:
            review.title,

          htmlLength:
            fave.htmlLength,

          linkCount:
            fave.links.length,

          links:
            fave.links
        }
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
   FAVE DEBUG
========================================================= */

app.get(
  "/fave-debug",
  async (req, res) => {
    const title =
      String(
        req.query.q ||
        "בלאגן ביער"
      ).trim();

    try {
      const result =
        await searchFave(title);

      return res.json({
        success:
          result.links.length > 0,

        query:
          title,

        htmlLength:
          result.htmlLength,

        linkCount:
          result.links.length,

        links:
          result.links
      });

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
   SEARCH TVNETIL CATALOG
========================================================= */

app.get(
  "/search-tvnetil",
  async (req, res) => {
    const type =
      req.query.type === "series"
        ? "series"
        : "movie";

    const q =
      String(
        req.query.q || ""
      ).trim();

    if (!q) {
      return res.json({
        success: false,
        message:
          "Use ?q=movie name"
      });
    }

    try {
      const results = [];

      const wanted =
        normalize(q);

      for (
        let skip = 0;
        skip < 10000;
        skip += 100
      ) {
        const data =
          await getCatalog(
            type,
            skip
          );

        const metas =
          Array.isArray(data?.metas)
            ? data.metas
            : [];

        if (!metas.length) {
          break;
        }

        for (const item of metas) {
          const name =
            normalize(
              item.name ||
              item.title ||
              item.originalName ||
              item.originalTitle
            );

          if (
            name.includes(wanted) ||
            wanted.includes(name)
          ) {
            results.push(item);
          }
        }

        if (
          metas.length < 100
        ) {
          break;
        }
      }

      return res.json({
        success: true,
        query: q,
        type,
        count: results.length,

        results:
          results.map(
            item => ({
              id: item.id,

              name:
                item.name ||
                item.title,

              year:
                extractYear(
                  item.releaseInfo ||
                  item.releaseDate ||
                  item.year ||
                  item.name ||
                  item.title
                ),

              type:
                item.type,

              reviewUrl:
                findReviewUrlInObject(
                  item
                )
            })
          )
      });

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

    console.log(
      "STREAM REQUEST:",
      type,
      id
    );

    if (!id) {
      return res.json({
        streams: []
      });
    }

    try {
      /*
         =====================================================
         שלב 1 — IMDb -> Cinemeta
         =====================================================
      */

      const metaUrl =
        `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(id)}.json`;

      console.log(
        "CINEMETA:",
        metaUrl
      );

      const meta =
        await getJson(metaUrl);

      const metaData =
        meta?.meta || meta;

      const possibleTitles = [
        metaData?.name,
        metaData?.originalName,
        metaData?.title,
        metaData?.originalTitle
      ].filter(Boolean);

      console.log(
        "CINEMETA TITLES:",
        possibleTitles
      );

      /*
         =====================================================
         שלב 2 — מוצאים את הסרט בקטלוג TVNetil
         =====================================================
      */

      const catalogItem =
        await findCatalogItem(
          type,
          id,
          possibleTitles
        );

      if (!catalogItem) {
        console.log(
          "NO TVNETIL CATALOG ITEM"
        );

        return res.json({
          streams: []
        });
      }

      /*
         =====================================================
         שלב 3 — מוצאים את דף הסרט עצמו
         =====================================================
      */

      const reviewUrl =
        findReviewUrlInObject(
          catalogItem
        );

      if (!reviewUrl) {
        console.log(
          "NO TVNETIL REVIEW URL IN CATALOG ITEM"
        );

        return res.json({
          streams: []
        });
      }

      console.log(
        "TVNETIL MOVIE PAGE:",
        reviewUrl
      );

      /*
         =====================================================
         שלב 4 — קוראים את דף הסרט
         =====================================================
      */

      const review =
        await getTVNetilReview(
          reviewUrl
        );

      if (!review.title) {
        console.log(
          "NO EXACT TVNETIL TITLE"
        );

        return res.json({
          streams: []
        });
      }

      /*
         =====================================================
         שלב 5 — זה השם היחיד שנשלח ל-FaveZone
         =====================================================
      */

      const exactTVNetilTitle =
        review.title;

      console.log(
        "EXACT TVNETIL TITLE -> FAVEZONE:",
        exactTVNetilTitle
      );

      const fave =
        await searchFave(
          exactTVNetilTitle
        );

      console.log(
        "FAVEZONE LINKS:",
        fave.links.length
      );

      if (!fave.links.length) {
        return res.json({
          streams: []
        });
      }

      /*
         =====================================================
         שלב 6 — Streams
         =====================================================
      */

      const streams =
        buildStreams(
          fave.links,
          exactTVNetilTitle,
          type,
          id
        );

      return res.json({
        streams
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
      "TVNetil Direct Streams v1.9.0"
    );
  }
);

/* =========================================================
   VERCEL
========================================================= */

export default app;
