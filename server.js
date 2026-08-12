import express from "express";

const app = express();

const TVNETIL = "https://www.tvnetil.net";
const TVNETIL_API = "https://tvnetil-addon.vercel.app";
const FAVE = "https://www.favez0ne.net/search.php";

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "1.8.0",
  name: "TVNetil Direct Streams",
  description: "TVNetil Hebrew title -> FaveZone streams",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt", "tvnetil_"]
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
      (_, n) =>
        String.fromCharCode(parseInt(n, 16))
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

  console.log("TVNETIL CATALOG:", url);

  return await getJson(url);
}

/* =========================================================
   FIND EXACT TVNETIL ID
========================================================= */

async function findCatalogItemById(type, id) {
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

      return null;
    }

    const metas =
      Array.isArray(data?.metas)
        ? data.metas
        : [];

    if (!metas.length) {
      break;
    }

    const found =
      metas.find(item =>
        String(item?.id || "").trim() === id
      );

    if (found) {
      return found;
    }

    if (metas.length < 100) {
      break;
    }
  }

  return null;
}

/* =========================================================
   TVNETIL CATALOG SEARCH
========================================================= */

async function searchTVNetilCatalog(
  type,
  query,
  maxPages = 100
) {
  const wanted = normalize(query);

  if (!wanted) {
    return [];
  }

  const results = [];

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
        "TVNETIL CATALOG ERROR:",
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
      const name =
        normalize(
          item.name ||
          item.title ||
          item.originalName ||
          item.originalTitle
        );

      if (!name) {
        continue;
      }

      if (
        name.includes(wanted) ||
        wanted.includes(name)
      ) {
        results.push(item);
        continue;
      }

      const wantedWords =
        wanted
          .split(" ")
          .filter(
            word => word.length >= 2
          );

      const matched =
        wantedWords.filter(
          word => name.includes(word)
        ).length;

      if (
        wantedWords.length > 0 &&
        matched >= Math.ceil(
          wantedWords.length * 0.6
        )
      ) {
        results.push(item);
      }
    }

    if (metas.length < 100) {
      break;
    }
  }

  return results;
}

/* =========================================================
   TVNETIL WEBSITE SEARCH
========================================================= */

function buildTVNetilSearchUrl(query) {
  return (
    `${TVNETIL}/search/term/?` +
    `search_term=${encodeURIComponent(query)}` +
    `&type=all&go=`
  );
}

async function searchTVNetilWebsite(query) {
  const url =
    buildTVNetilSearchUrl(query);

  console.log(
    "TVNETIL WEBSITE SEARCH:",
    url
  );

  const html =
    await getText(url);

  return {
    url,
    html
  };
}

/* =========================================================
   EXTRACT TVNETIL REVIEW LINKS
========================================================= */

function extractReviewLinks(html) {
  const results = [];

  const regex =
    /(?:https?:\/\/(?:www\.)?tvnetil\.net)?(\/review\/\d+\/?)/gi;

  let match;

  while (
    (match = regex.exec(html)) !== null
  ) {
    const path =
      match[1];

    const url =
      `${TVNETIL}${path}`;

    results.push(url);
  }

  return [
    ...new Set(results)
  ];
}

/* =========================================================
   EXTRACT TVNETIL TITLE
========================================================= */

function extractTVNetilTitle(html) {
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

  match =
    html.match(
      /<h1[^>]*>([\s\S]*?)<\/h1>/i
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

  match =
    html.match(
      /<h2[^>]*>([\s\S]*?)<\/h2>/i
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

  return null;
}

/* =========================================================
   TVNETIL REVIEW
========================================================= */

async function getTVNetilReview(url) {
  console.log(
    "TVNETIL REVIEW:",
    url
  );

  const html =
    await getText(url);

  const title =
    extractTVNetilTitle(html);

  return {
    url,
    title,
    html
  };
}

/* =========================================================
   FIND TVNETIL REVIEW
========================================================= */

async function findTVNetilReview(
  query,
  type = "movie"
) {
  const catalogResults =
    await searchTVNetilCatalog(
      type,
      query
    );

  console.log(
    "TVNETIL CATALOG RESULTS:",
    catalogResults.length
  );

  const search =
    await searchTVNetilWebsite(
      query
    );

  const reviewLinks =
    extractReviewLinks(
      search.html
    );

  console.log(
    "TVNETIL REVIEW LINKS:",
    reviewLinks
  );

  for (const reviewUrl of reviewLinks) {
    try {
      const review =
        await getTVNetilReview(
          reviewUrl
        );

      if (review.title) {
        return {
          success: true,
          catalogResults,
          searchUrl:
            search.url,
          reviewUrl,
          title:
            review.title
        };
      }
    } catch (error) {
      console.error(
        "REVIEW ERROR:",
        error.message
      );
    }
  }

  return {
    success: false,
    catalogResults,
    searchUrl:
      search.url,
    reviewLinks,
    title: null
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
    "FAVEZONE SEARCH:",
    title
  );

  const html =
    await getText(
      FAVE,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded; charset=windows-1255",

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

  return html;
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
    let url =
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
    let url =
      decodeHtml(match[0])
        .replace(
          /[\r\n\t]/g,
          ""
        )
        .replace(
          /[),.;]+$/,
          ""
        )
        .trim();

    results.push(url);
  }

  const unique =
    [
      ...new Set(results)
    ];

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
    await searchFavez0ne(
      title
    );

  const links =
    extractFavezLinks(
      html
    );

  return {
    title,
    htmlLength:
      html.length,
    links
  };
}

/* =========================================================
   TEST TITLE
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
      const tv =
        await findTVNetilReview(
          q,
          type
        );

      if (!tv.success) {
        return res.json({
          success: false,
          step:
            "tvnetil-review",
          query:
            q,
          tvnetil:
            tv
        });
      }

      const hebrewTitle =
        tv.title;

      console.log(
        "TVNETIL PAGE TITLE:",
        hebrewTitle
      );

      const fave =
        await searchFave(
          hebrewTitle
        );

      return res.json({
        success:
          fave.links.length > 0,

        input: {
          query:
            q,
          type
        },

        tvnetil: {
          searchUrl:
            tv.searchUrl,

          reviewUrl:
            tv.reviewUrl,

          title:
            hebrewTitle
        },

        favezone: {
          searchTitle:
            hebrewTitle,

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
   SEARCH TVNETIL
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
      const results =
        await searchTVNetilCatalog(
          type,
          q
        );

      return res.json({
        success: true,
        query:
          q,
        type,
        count:
          results.length,

        results:
          results.map(
            item => ({
              id:
                item.id,

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
                item.type
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
        await searchFave(
          title
        );

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

    try {

      /*
         כרגע אנחנו תומכים
         ב־TVNetil IDs.
      */

      if (
        !id.startsWith(
          "tvnetil_"
        )
      ) {

        return res.json({
          streams: [],
          debug: {
            id,
            type,
            reason:
              "Unsupported ID prefix"
          }
        });
      }

      /*
         מחפשים את ה־ID המדויק
         בתוך קטלוג TVNetil.
      */

      const item =
        await findCatalogItemById(
          type,
          id
        );

      if (!item) {

        console.log(
          "TVNETIL ITEM NOT FOUND:",
          id
        );

        return res.json({
          streams: [],
          debug: {
            id,
            type,
            found: false
          }
        });
      }

      /*
         שם הסרט כפי שמופיע
         בקטלוג TVNetil.
      */

      const title =
        item.name ||
        item.title ||
        item.originalName ||
        item.originalTitle ||
        "";

      console.log(
        "TVNETIL ITEM FOUND:",
        id,
        title
      );

      /*
         בשלב הזה מחזירים debug בלבד.
         כך נוכל לוודא ש־Nuvio
         מצליח להגיע לסרט הנכון.
      */

      return res.json({

        streams: [],

        debug: {
          id,
          type,
          found: true,
          title,

          year:
            extractYear(
              item.releaseInfo ||
              item.releaseDate ||
              item.year ||
              ""
            )
        }

      });

    } catch (error) {

      console.error(
        "STREAM ERROR:",
        error.stack ||
        error.message
      );

      return res.status(500).json({

        streams: [],

        error:
          error.stack ||
          error.message

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
      "TVNetil Direct Streams v1.8.0"
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
      "TVNetil Direct Streams v1.8.0 started"
    );

  }
);
