import express from "express";

const app = express();

const TVNETIL = "https://www.tvnetil.net";
const TVNETIL_API = "https://tvnetil-addon.vercel.app";
const FAVE = "https://www.favez0ne.net/search.php";

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "2.0.0",
  name: "TVNetil Direct Streams",
  description: "TVNetil page title -> FaveZone streams",
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

  return JSON.parse(text);
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
  const match =
    String(value || "").match(/\b(19|20)\d{2}\b/);

  return match ? Number(match[0]) : null;
}

function similarityScore(a, b) {
  const aa = normalize(a);
  const bb = normalize(b);

  if (!aa || !bb) {
    return 0;
  }

  if (aa === bb) {
    return 100;
  }

  if (aa.includes(bb) || bb.includes(aa)) {
    return 80;
  }

  const aw = new Set(
    aa.split(" ").filter(x => x.length >= 2)
  );

  const bw = new Set(
    bb.split(" ").filter(x => x.length >= 2)
  );

  if (!aw.size || !bw.size) {
    return 0;
  }

  let common = 0;

  for (const word of aw) {
    if (bw.has(word)) {
      common++;
    }
  }

  return Math.round(
    (common / Math.max(aw.size, bw.size)) * 70
  );
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

/* =========================================================
   FIND ITEM IN CATALOG
========================================================= */

async function findCatalogItem(
  type,
  imdbId,
  titles = []
) {
  const wantedId =
    String(imdbId || "").trim();

  const normalizedTitles =
    titles
      .filter(Boolean)
      .map(normalize);

  for (
    let skip = 0;
    skip < 10000;
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

    /* IMDb exact match */

    if (wantedId) {
      for (const item of metas) {
        const ids = [
          item.id,
          item.imdb_id,
          item.imdbId
        ]
          .filter(Boolean)
          .map(String);

        if (
          ids.includes(wantedId)
        ) {
          return item;
        }
      }
    }

    /* Title match */

    for (const item of metas) {
      const names = [
        item.name,
        item.title,
        item.originalName,
        item.originalTitle
      ]
        .filter(Boolean)
        .map(normalize);

      for (const wanted of normalizedTitles) {
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
    }

    if (metas.length < 100) {
      break;
    }
  }

  return null;
}

/* =========================================================
   EXTRACT REVIEW LINKS FROM HTML
========================================================= */

function extractReviewLinks(html) {
  const results = [];

  const regex =
    /(?:href\s*=\s*["'])([^"']*\/review\/[^"']+)(?:["'])/gi;

  let match;

  while (
    (match = regex.exec(html)) !== null
  ) {
    let url =
      decodeHtml(match[1])
        .replace(/[\r\n\t]/g, "")
        .trim();

    if (
      url.startsWith("/")
    ) {
      url =
        `${TVNETIL}${url}`;
    }

    if (
      /^https?:\/\//i.test(url) &&
      /\/review\//i.test(url)
    ) {
      results.push(url);
    }
  }

  return [
    ...new Set(results)
  ];
}

/* =========================================================
   EXTRACT LINK TEXT / CONTEXT
========================================================= */

function extractReviewCandidates(html) {
  const results = [];

  const regex =
    /<a\b[^>]*href\s*=\s*["']([^"']*\/review\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while (
    (match = regex.exec(html)) !== null
  ) {
    let url =
      decodeHtml(match[1])
        .replace(/[\r\n\t]/g, "")
        .trim();

    if (
      url.startsWith("/")
    ) {
      url =
        `${TVNETIL}${url}`;
    }

    const text =
      cleanText(match[2]);

    if (
      /^https?:\/\//i.test(url)
    ) {
      results.push({
        url,
        text
      });
    }
  }

  return results;
}

/* =========================================================
   TVNETIL REVIEW LIST
========================================================= */

async function getReviewListPages() {
  /*
     TVNetil uses mPage pagination.
     We inspect multiple pages because the target
     can be anywhere in the catalog.
  */

  const pages = [];

  for (
    let page = 0;
    page < 100;
    page++
  ) {
    pages.push(
      `${TVNETIL}/reviews/show/y/g/29/mPage/${page}/`
    );
  }

  return pages;
}

/* =========================================================
   FIND REVIEW BY TITLE
========================================================= */

async function findReviewByTitle(
  titles,
  year = null
) {
  const wantedTitles =
    titles
      .filter(Boolean)
      .map(normalize);

  if (!wantedTitles.length) {
    return null;
  }

  const pages =
    await getReviewListPages();

  for (const pageUrl of pages) {
    let html;

    try {
      console.log(
        "TVNETIL REVIEW LIST:",
        pageUrl
      );

      html =
        await getText(
          pageUrl
        );
    } catch (error) {
      console.error(
        "REVIEW LIST ERROR:",
        error.message
      );

      /*
         Cloudflare/403:
         continue to next possible source.
      */

      continue;
    }

    const candidates =
      extractReviewCandidates(
        html
      );

    if (!candidates.length) {
      continue;
    }

    let best = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      const text =
        normalize(candidate.text);

      for (const wanted of wantedTitles) {
        let score =
          similarityScore(
            text,
            wanted
          );

        if (
          year &&
          text.includes(String(year))
        ) {
          score += 15;
        }

        if (score > bestScore) {
          bestScore = score;

          best = {
            url: candidate.url,
            text: candidate.text,
            score
          };
        }
      }
    }

    if (
      best &&
      best.score >= 55
    ) {
      console.log(
        "FOUND TVNETIL REVIEW:",
        best
      );

      return best.url;
    }
  }

  return null;
}

/* =========================================================
   FIND REVIEW URL
========================================================= */

async function findTVNetilReviewUrl(
  catalogItem,
  titles,
  year
) {
  /*
     1. אם ה-API בעתיד יוסיף URL,
        נשתמש בו.
  */

  const directValues = [
    catalogItem?.url,
    catalogItem?.link,
    catalogItem?.href,
    catalogItem?.webUrl,
    catalogItem?.website,
    catalogItem?.pageUrl,
    catalogItem?.reviewUrl
  ];

  for (const value of directValues) {
    if (
      typeof value === "string" &&
      /\/review\//i.test(value)
    ) {
      return value.startsWith("/")
        ? `${TVNETIL}${value}`
        : value;
    }
  }

  /*
     2. אם אין URL בקטלוג,
        מוצאים את דף הסרט ברשימת הסיקורים.
  */

  const catalogName =
    catalogItem?.name ||
    catalogItem?.title;

  const searchTitles = [
    catalogName,
    ...titles
  ].filter(Boolean);

  return await findReviewByTitle(
    searchTitles,
    year
  );
}

/* =========================================================
   OPEN TVNETIL MOVIE PAGE
========================================================= */

async function getTVNetilMoviePage(
  url
) {
  console.log(
    "OPEN TVNETIL PAGE:",
    url
  );

  const html =
    await getText(url);

  return {
    url,
    html,
    title:
      extractExactPageTitle(html)
  };
}

/* =========================================================
   EXACT TITLE FROM TVNETIL PAGE
========================================================= */

function extractExactPageTitle(html) {
  /*
     FIRST PRIORITY:
     H1/H2 on the actual TVNetil page.
  */

  for (
    const tag of ["h1", "h2"]
  ) {
    const regex =
      new RegExp(
        `<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`,
        "i"
      );

    const match =
      html.match(regex);

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

  /*
     SECOND PRIORITY:
     og:title
  */

  const og =
    html.match(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
    );

  if (og) {
    const title =
      cleanText(og[1]);

    if (title) {
      return title;
    }
  }

  /*
     THIRD PRIORITY:
     page title
  */

  const pageTitle =
    html.match(
      /<title[^>]*>([\s\S]*?)<\/title>/i
    );

  if (pageTitle) {
    let title =
      cleanText(pageTitle[1]);

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
   FAVEZONE
========================================================= */

async function searchFavez0ne(
  exactTVNetilTitle
) {
  const body =
    new URLSearchParams({
      srch:
        exactTVNetilTitle,

      "submit.x":
        "0",

      "submit.y":
        "0"
    }).toString();

  console.log(
    "FAVEZONE EXACT SEARCH:",
    exactTVNetilTitle
  );

  return await getText(
    FAVE,
    {
      method:
        "POST",

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",

        "Referer":
          "https://www.favez0ne.net/",

        "Origin":
          "https://www.favez0ne.net/",

        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },

      body
    }
  );
}

/* =========================================================
   FAVE LINKS
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

  return unique.filter(
    url => {
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
    }
  );
}

/* =========================================================
   BUILD STREAMS
========================================================= */

function buildStreams(
  links,
  exactTitle,
  type,
  id
) {
  return links.map(
    url => ({
      name:
        `TVNetil • ${exactTitle}`,

      title:
        `צפייה ישירה • ${exactTitle}`,

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
   DEBUG TEST
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
         Find movie in TVNetil catalog.
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

      const year =
        extractYear(
          catalogItem.name ||
          catalogItem.title ||
          ""
        );

      /*
         Find actual TVNetil page.
      */

      const reviewUrl =
        await findTVNetilReviewUrl(
          catalogItem,
          [q],
          year
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
            "הסרט נמצא בקטלוג אבל לא נמצאה כתובת דף הסרט"
        });
      }

      /*
         Open ACTUAL movie page.
      */

      const page =
        await getTVNetilMoviePage(
          reviewUrl
        );

      if (!page.title) {
        return res.json({
          success: false,

          step:
            "tvnetil-page-title",

          reviewUrl,

          message:
            "דף הסרט נמצא אבל לא נמצא שם בתוך הדף"
        });
      }

      /*
         ONLY this title goes to FaveZone.
      */

      const fave =
        await searchFavez0ne(
          page.title
        );

      const links =
        extractFavezLinks(
          fave
        );

      return res.json({
        success:
          links.length > 0,

        flow: [
          "IMDb / title",
          "TVNetil catalog",
          "TVNetil actual movie page",
          "Exact title from TVNetil page",
          "FaveZone"
        ],

        tvnetil: {
          catalogItem,
          reviewUrl,
          exactPageTitle:
            page.title
        },

        favezone: {
          searchTitle:
            page.title,

          linkCount:
            links.length,

          links
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
      "STREAM:",
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
         1. IMDb -> Cinemeta
         =====================================================
      */

      const metaUrl =
        `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(id)}.json`;

      const meta =
        await getJson(
          metaUrl
        );

      const metaData =
        meta?.meta || meta;

      const titles = [
        metaData?.name,
        metaData?.originalName,
        metaData?.title,
        metaData?.originalTitle
      ].filter(Boolean);

      const year =
        extractYear(
          metaData?.releaseInfo ||
          metaData?.released ||
          metaData?.releaseDate ||
          metaData?.year ||
          ""
        );

      console.log(
        "CINEMETA TITLES:",
        titles
      );

      /*
         =====================================================
         2. Find matching item in TVNetil
         =====================================================
      */

      const catalogItem =
        await findCatalogItem(
          type,
          id,
          titles
        );

      if (!catalogItem) {
        console.log(
          "TVNETIL CATALOG ITEM NOT FOUND"
        );

        return res.json({
          streams: []
        });
      }

      /*
         =====================================================
         3. Find ACTUAL TVNetil movie/series page
         =====================================================
      */

      const reviewUrl =
        await findTVNetilReviewUrl(
          catalogItem,
          titles,
          year
        );

      if (!reviewUrl) {
        console.log(
          "TVNETIL ACTUAL PAGE NOT FOUND"
        );

        return res.json({
          streams: []
        });
      }

      /*
         =====================================================
         4. Open actual TVNetil page
         =====================================================
      */

      const page =
        await getTVNetilMoviePage(
          reviewUrl
        );

      if (!page.title) {
        console.log(
          "TVNETIL PAGE TITLE NOT FOUND"
        );

        return res.json({
          streams: []
        });
      }

      /*
         =====================================================
         5. IMPORTANT:
            The title from the actual TVNetil page
            is the ONLY title sent to FaveZone.
         =====================================================
      */

      const exactTVNetilTitle =
        page.title;

      console.log(
        "EXACT TVNETIL PAGE TITLE:",
        exactTVNetilTitle
      );

      /*
         =====================================================
         6. FaveZone search
         =====================================================
      */

      const faveHtml =
        await searchFavez0ne(
          exactTVNetilTitle
        );

      const links =
        extractFavezLinks(
          faveHtml
        );

      console.log(
        "FAVEZONE LINKS:",
        links.length
      );

      if (!links.length) {
        return res.json({
          streams: []
        });
      }

      /*
         =====================================================
         7. Nuvio streams
         =====================================================
      */

      return res.json({
        streams:
          buildStreams(
            links,
            exactTVNetilTitle,
            type,
            id
          )
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
      "TVNetil Direct Streams v2.0.0"
    );
  }
);

/* =========================================================
   VERCEL
========================================================= */

export default app;
