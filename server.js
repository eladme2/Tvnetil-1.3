import express from "express";

const app = express();

/* =========================================================
   CONFIG
========================================================= */

const TV = "https://tvnetil-addon.vercel.app";
const CM = "https://v3-cinemeta.strem.io/meta";
const FAVE = "https://www.favez0ne.net/search.php";

/* TMDB API KEY */
const TMDB_KEY = "39e6950a7ffa18878e6428b3b708351f";

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "1.6.0",
  name: "TVNetil Direct Streams",
  description:
    "Hebrew TVNetil title matching for Nuvio/Cinemeta",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"]
};

/* =========================================================
   MANIFEST
========================================================= */

app.get("/manifest.json", (_, res) => {
  res.json(MANIFEST);
});

/* =========================================================
   HTTP
========================================================= */

async function getText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",

      Accept:
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

async function getJson(url, options = {}) {
  const text = await getText(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {})
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
   TEXT HELPERS
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

function extractYear(value) {
  const match = String(value || "")
    .match(/\b(19|20)\d{2}\b/);

  return match ? Number(match[0]) : null;
}

function getItemYear(item) {
  return extractYear(
    item.releaseInfo ||
    item.releaseDate ||
    item.year ||
    item.description ||
    item.name ||
    item.title
  );
}

/* =========================================================
   CINEMETA
========================================================= */

async function getCinemeta(type, imdbId) {
  return getJson(
    `${CM}/${type}/${imdbId}.json`
  );
}

/* =========================================================
   TMDB
========================================================= */

/*
  מקבל TMDB ID ומחזיר את הכותרת העברית.
*/

async function getTMDBHebrewTitle(
  type,
  tmdbId
) {
  if (!TMDB_KEY || !tmdbId) {
    return null;
  }

  const endpoint =
    type === "series"
      ? "tv"
      : "movie";

  const url =
    `https://api.themoviedb.org/3/${endpoint}/${tmdbId}` +
    `?api_key=${encodeURIComponent(TMDB_KEY)}` +
    `&language=he-IL`;

  console.log(
    "TMDB HEBREW REQUEST:",
    url.replace(TMDB_KEY, "***")
  );

  try {
    const data =
      await getJson(url);

    const title =
      type === "series"
        ? data.name
        : data.title;

    console.log(
      "TMDB HEBREW TITLE:",
      title
    );

    return title || null;

  } catch (error) {
    console.error(
      "TMDB ERROR:",
      error.message
    );

    return null;
  }
}

/*
  במקרה שאין TMDB ID ב-Cinemeta,
  ננסה למצוא אותו לפי IMDb.
*/

async function findTMDBByIMDb(
  type,
  imdbId
) {
  if (!TMDB_KEY) {
    return null;
  }

  const url =
    `https://api.themoviedb.org/3/find/${imdbId}` +
    `?api_key=${encodeURIComponent(TMDB_KEY)}` +
    `&external_source=imdb_id`;

  try {
    const data =
      await getJson(url);

    const list =
      type === "series"
        ? data.tv_results
        : data.movie_results;

    if (
      Array.isArray(list) &&
      list.length > 0
    ) {
      return list[0].id;
    }

    return null;

  } catch (error) {
    console.error(
      "TMDB FIND ERROR:",
      error.message
    );

    return null;
  }
}

/* =========================================================
   TVNETIL CATALOG
========================================================= */

async function getCatalog(
  type,
  skip = 0
) {
  const catalog =
    type === "series"
      ? "tvnetil_series"
      : "tvnetil_movies";

  const url =
    `${TV}/catalog/${type}/${catalog}.json?skip=${skip}`;

  console.log(
    "TVNETIL CATALOG:",
    url
  );

  return getJson(url);
}

/* =========================================================
   TVNETIL SEARCH
========================================================= */

async function searchTVNetilCatalog(
  type,
  query,
  maxPages = 100
) {
  const wanted =
    normalize(query);

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
        "TVNETIL SEARCH ERROR:",
        error.message
      );
      break;
    }

    const metas =
      Array.isArray(data.metas)
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
        name === wanted ||
        name.includes(wanted) ||
        wanted.includes(name)
      ) {
        results.push(item);
        continue;
      }

      const wantedWords =
        wanted
          .split(" ")
          .filter(x => x.length >= 2);

      if (!wantedWords.length) {
        continue;
      }

      const matched =
        wantedWords.filter(
          word => name.includes(word)
        ).length;

      if (
        matched >=
        Math.ceil(
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
   SCORE TVNETIL RESULT
========================================================= */

function scoreTVNetil(
  item,
  wantedNames,
  wantedYear
) {
  const itemName =
    normalize(
      item.name ||
      item.title ||
      item.originalName ||
      item.originalTitle
    );

  if (!itemName) {
    return -1;
  }

  let best = -1;

  for (const rawName of wantedNames) {
    const wanted =
      normalize(rawName);

    if (!wanted) {
      continue;
    }

    let score = 0;

    if (itemName === wanted) {
      score += 300;
    } else if (
      itemName.includes(wanted) ||
      wanted.includes(itemName)
    ) {
      score += 150;
    }

    const wantedWords =
      wanted.split(" ");

    const itemWords =
      new Set(
        itemName.split(" ")
      );

    for (const word of wantedWords) {
      if (
        word.length >= 2 &&
        itemWords.has(word)
      ) {
        score += 15;
      }
    }

    const itemYear =
      getItemYear(item);

    if (
      wantedYear &&
      itemYear
    ) {
      if (
        wantedYear === itemYear
      ) {
        score += 80;
      } else if (
        Math.abs(
          wantedYear - itemYear
        ) === 1
      ) {
        score += 10;
      } else {
        score -= 100;
      }
    }

    best =
      Math.max(
        best,
        score
      );
  }

  return best;
}

/* =========================================================
   FIND TVNETIL BY HEBREW TITLE
========================================================= */

async function findTVNetilByHebrew(
  type,
  hebrewTitle,
  wantedYear
) {
  console.log(
    "TVNETIL HEBREW SEARCH:",
    hebrewTitle
  );

  const results =
    await searchTVNetilCatalog(
      type,
      hebrewTitle
    );

  console.log(
    "TVNETIL SEARCH RESULTS:",
    results.length
  );

  if (!results.length) {
    return null;
  }

  let best = null;
  let bestScore = -1;

  for (const item of results) {
    const s =
      scoreTVNetil(
        item,
        [hebrewTitle],
        wantedYear
      );

    console.log(
      "TVNETIL RESULT:",
      item.id,
      item.name,
      s
    );

    if (s > bestScore) {
      bestScore = s;
      best = item;
    }
  }

  if (
    !best ||
    bestScore < 100
  ) {
    return null;
  }

  return {
    item: best,
    score: bestScore
  };
}

/* =========================================================
   FAVEZONE SEARCH
========================================================= */

async function searchFavez0ne(
  title
) {
  console.log(
    "FAVEZONE SEARCH:",
    title
  );

  const body =
    new URLSearchParams({
      srch: title,
      "submit.x": "0",
      "submit.y": "0"
    }).toString();

  return getText(
    FAVE,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded; charset=windows-1255",

        Referer:
          "https://www.favez0ne.net/",

        Origin:
          "https://www.favez0ne.net",

        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },

      body
    }
  );
}

/* =========================================================
   HTML DECODE
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
      (_, n) =>
        String.fromCharCode(
          Number(n)
        )
    )
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, n) =>
        String.fromCharCode(
          parseInt(n, 16)
        )
    );
}

/* =========================================================
   FAVEZONE LINKS
========================================================= */

function extractFavezLinks(
  html
) {
  const results = [];

  const hrefRegex =
    /href\s*=\s*["']([^"']+)["']/gi;

  let match;

  while (
    (match =
      hrefRegex.exec(html)) !== null
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
   HOST
========================================================= */

function hostName(url) {
  try {
    const host =
      new URL(url)
        .hostname
        .toLowerCase();

    if (
      host.includes("pixeldrain")
    ) {
      return "Pixeldrain";
    }

    if (
      host.includes("gofile")
    ) {
      return "Gofile";
    }

    if (
      host.includes("mega.nz")
    ) {
      return "Mega";
    }

    if (
      host.includes("1fichier")
    ) {
      return "1fichier";
    }

    if (
      host.includes("send.now")
    ) {
      return "Send.now";
    }

    if (
      host.includes("usersdrive")
    ) {
      return "UsersDrive";
    }

    return host;

  } catch {
    return "Favez0ne";
  }
}

/* =========================================================
   STREAMS
========================================================= */

function cleanStreams(
  urls
) {
  return urls.map(
    url => ({
      name: "TVNetil",

      title:
        `${hostName(url)} | TVNetil`,

      url,

      behaviorHints: {
        notWebReady: true
      }
    })
  );
}

/* =========================================================
   BUILD FAVE TITLE
========================================================= */

function buildFaveTitle(
  tvTitle,
  tvYear
) {
  let title =
    String(
      tvTitle || ""
    ).trim();

  /*
    TVNetil כבר נותן לעיתים:
    בלאגן ביער (2025)

    לכן לא מוסיפים שנה פעם נוספת.
  */

  if (
    tvYear &&
    !extractYear(title)
  ) {
    title =
      `${title} (${tvYear})`;
  }

  return title;
}

/* =========================================================
   MAIN STREAM
========================================================= */

app.get(
  "/stream/:type/:id.json",
  async (
    req,
    res
  ) => {

    const {
      type,
      id
    } = req.params;

    console.log(
      "================================"
    );

    console.log(
      "STREAM REQUEST:",
      type,
      id
    );

    if (
      !["movie", "series"]
        .includes(type) ||
      !/^tt\d+$/.test(id)
    ) {
      return res.json({
        streams: []
      });
    }

    try {

      /* ---------------------------------
         1. CINEMETA
      --------------------------------- */

      const cinemeta =
        await getCinemeta(
          type,
          id
        );

      const meta =
        cinemeta?.meta;

      if (!meta?.name) {
        return res.json({
          streams: []
        });
      }

      const wantedYear =
        extractYear(
          meta.releaseInfo ||
          meta.releaseDate ||
          meta.year
        );

      console.log(
        "CINEMETA NAME:",
        meta.name
      );

      console.log(
        "CINEMETA YEAR:",
        wantedYear
      );

      console.log(
        "CINEMETA TMDB:",
        meta.moviedb_id
      );

      /* ---------------------------------
         2. GET TMDB ID
      --------------------------------- */

      let tmdbId =
        meta.moviedb_id ||
        null;

      if (!tmdbId) {
        tmdbId =
          await findTMDBByIMDb(
            type,
            id
          );
      }

      console.log(
        "TMDB ID:",
        tmdbId
      );

      /* ---------------------------------
         3. GET HEBREW TITLE
      --------------------------------- */

      let hebrewTitle =
        null;

      if (tmdbId) {
        hebrewTitle =
          await getTMDBHebrewTitle(
            type,
            tmdbId
          );
      }

      /*
        אם TMDB לא החזיר שם עברי,
        ננסה את השם מ-Cinemeta.
      */

      if (!hebrewTitle) {
        hebrewTitle =
          meta.name;
      }

      console.log(
        "HEBREW SEARCH TITLE:",
        hebrewTitle
      );

      /* ---------------------------------
         4. SEARCH TVNETIL
      --------------------------------- */

      const matched =
        await findTVNetilByHebrew(
          type,
          hebrewTitle,
          wantedYear
        );

      if (
        !matched?.item
      ) {

        console.log(
          "NO TVNETIL MATCH FOR:",
          hebrewTitle
        );

        return res.json({
          streams: []
        });
      }

      const item =
        matched.item;

      const tvTitle =
        item.name ||
        item.title;

      const tvYear =
        getItemYear(item);

      console.log(
        "TVNETIL MATCH:",
        item.id,
        tvTitle,
        matched.score
      );

      /* ---------------------------------
         5. SEARCH FAVEZONE
      --------------------------------- */

      const faveTitle =
        buildFaveTitle(
          tvTitle,
          tvYear
        );

      console.log(
        "FAVEZONE TITLE:",
        faveTitle
      );

      let html =
        await searchFavez0ne(
          faveTitle
        );

      let urls =
        extractFavezLinks(
          html
        );

      /*
        Fallback:
        בלי השנה.
      */

      if (
        urls.length === 0
      ) {

        const withoutYear =
          String(tvTitle)
            .replace(
              /\s*\(\d{4}\)\s*$/,
              ""
            )
            .trim();

        if (
          withoutYear !==
          faveTitle
        ) {

          console.log(
            "FAVEZONE FALLBACK:",
            withoutYear
          );

          html =
            await searchFavez0ne(
              withoutYear
            );

          urls =
            extractFavezLinks(
              html
            );
        }
      }

      console.log(
        "FAVEZONE LINKS:",
        urls
      );

      /* ---------------------------------
         6. RETURN STREAMS
      --------------------------------- */

      const streams =
        cleanStreams(urls);

      console.log(
        "STREAM COUNT:",
        streams.length
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
   SEARCH TVNETIL
   TEST ENDPOINT
========================================================= */

app.get(
  "/search-tvnetil",
  async (
    req,
    res
  ) => {

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
                getItemYear(item),

              type:
                item.type
            })
          )
      });

    } catch (error) {

      return res.status(500)
        .json({
          success: false,
          error:
            error.stack ||
            error.message
        });
    }
  }
);

/* =========================================================
   HEBREW DEBUG
========================================================= */

app.get(
  "/debug/:type/:id.json",
  async (
    req,
    res
  ) => {

    const {
      type,
      id
    } = req.params;

    try {

      if (
        !["movie", "series"]
          .includes(type) ||
        !/^tt\d+$/.test(id)
      ) {
        return res.status(400)
          .json({
            success: false,
            error:
              "Invalid type or IMDb ID"
          });
      }

      /* ---------------------------------
         CINEMETA
      --------------------------------- */

      const cinemeta =
        await getCinemeta(
          type,
          id
        );

      const meta =
        cinemeta?.meta;

      if (!meta?.name) {
        return res.json({
          success: false,
          step: "cinemeta"
        });
      }

      const wantedYear =
        extractYear(
          meta.releaseInfo ||
          meta.releaseDate ||
          meta.year
        );

      /* ---------------------------------
         TMDB
      --------------------------------- */

      let tmdbId =
        meta.moviedb_id ||
        null;

      if (!tmdbId) {
        tmdbId =
          await findTMDBByIMDb(
            type,
            id
          );
      }

      const hebrewTitle =
        tmdbId
          ? await getTMDBHebrewTitle(
              type,
              tmdbId
            )
          : null;

      /* ---------------------------------
         TVNETIL
      --------------------------------- */

      const matched =
        await findTVNetilByHebrew(
          type,
          hebrewTitle ||
            meta.name,
          wantedYear
        );

      if (
        !matched?.item
      ) {
        return res.json({

          success: false,

          step:
            "tvnetil-hebrew-search",

          cinemeta: {
            id,
            name:
              meta.name,
            year:
              wantedYear,
            tmdb:
              tmdbId
          },

          hebrewTitle:
            hebrewTitle,

          message:
            "No TVNetil result for Hebrew title"
        });
      }

      const item =
        matched.item;

      const tvTitle =
        item.name ||
        item.title;

      const tvYear =
        getItemYear(item);

      const faveTitle =
        buildFaveTitle(
          tvTitle,
          tvYear
        );

      /* ---------------------------------
         FAVEZONE
      --------------------------------- */

      let html =
        await searchFavez0ne(
          faveTitle
        );

      let urls =
        extractFavezLinks(
          html
        );

      let searchUsed =
        faveTitle;

      if (
        urls.length === 0
      ) {

        const withoutYear =
          String(tvTitle)
            .replace(
              /\s*\(\d{4}\)\s*$/,
              ""
            )
            .trim();

        if (
          withoutYear !==
          faveTitle
        ) {

          html =
            await searchFavez0ne(
              withoutYear
            );

          urls =
            extractFavezLinks(
              html
            );

          searchUsed =
            withoutYear;
        }
      }

      return res.json({

        success: true,

        cinemeta: {
          id,
          name:
            meta.name,
          year:
            wantedYear,
          tmdb:
            tmdbId
        },

        hebrew: {
          title:
            hebrewTitle
        },

        tvnetil: {
          id:
            item.id,

          name:
            tvTitle,

          year:
            tvYear,

          score:
            matched.score
        },

        favezone: {
          searchTitle:
            searchUsed,

          linkCount:
            urls.length,

          links:
            urls
        },

        streams:
          cleanStreams(urls)
      });

    } catch (error) {

      return res.status(500)
        .json({

          success: false,

          error:
            error.stack ||
            error.message

        });
    }
  }
);

/* =========================================================
   TMDB DEBUG
========================================================= */

app.get(
  "/tmdb-debug/:type/:id",
  async (
    req,
    res
  ) => {

    const {
      type,
      id
    } = req.params;

    try {

      let tmdbId = id;

      if (
        /^tt\d+$/.test(id)
      ) {
        tmdbId =
          await findTMDBByIMDb(
            type,
            id
          );
      }

      if (!tmdbId) {
        return res.json({
          success: false,
          message:
            "TMDB ID not found"
        });
      }

      const title =
        await getTMDBHebrewTitle(
          type,
          tmdbId
        );

      return res.json({
        success: true,
        type,
        tmdbId,
        hebrewTitle:
          title
      });

    } catch (error) {

      return res.status(500)
        .json({
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
  async (
    req,
    res
  ) => {

    const title =
      String(
        req.query.q ||
        "בלאגן ביער"
      );

    try {

      const html =
        await searchFavez0ne(
          title
        );

      const links =
        extractFavezLinks(
          html
        );

      return res.json({

        success: true,

        query:
          title,

        htmlLength:
          html.length,

        links,

        html

      });

    } catch (error) {

      return res.status(500)
        .json({

          success: false,

          error:
            error.stack ||
            error.message

        });
    }
  }
);

/* =========================================================
   HOME
========================================================= */

app.get(
  "/",
  (_, res) => {

    res.send(
      "TVNetil Direct Streams v1.6.0 - LIVE"
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
      "TVNetil Direct Streams v1.6.0 started"
    );

  }
);
