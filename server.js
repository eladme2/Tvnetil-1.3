import express from "express";

const app = express();

/* =========================================================
   CONFIG
========================================================= */

const TV = "https://tvnetil-addon.vercel.app";
const CM = "https://v3-cinemeta.strem.io/meta";
const FAVE = "https://www.favez0ne.net/search.php";

const TMDB_API_KEY = "39e6950a7ffa18878e6428b3b708351f";

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "1.6.0",
  name: "TVNetil Direct Streams",
  description:
    "TVNetil Hebrew titles -> Favez0ne streams for Nuvio/Cinemeta",
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

async function getJson(url, options = {}) {
  const text = await getText(url, {
    ...options,

    headers: {
      "Accept": "application/json",
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
    item.firstAirDate ||
    item.description ||
    item.name ||
    item.title
  );
}

/* =========================================================
   CINEMETA
========================================================= */

async function getCinemeta(type, imdbId) {
  const url =
    `${CM}/${type}/${imdbId}.json`;

  console.log("CINEMETA:", url);

  return await getJson(url);
}

/* =========================================================
   TMDB
========================================================= */

async function getTMDBDetails(type, tmdbId) {
  if (!tmdbId) {
    return null;
  }

  const endpoint =
    type === "series"
      ? `https://api.themoviedb.org/3/tv/${tmdbId}`
      : `https://api.themoviedb.org/3/movie/${tmdbId}`;

  const url =
    `${endpoint}?language=he-IL`;

  console.log(
    "TMDB HEBREW:",
    url
  );

  try {
    return await getJson(url, {
      headers: {
        "Authorization":
          `Bearer ${TMDB_API_KEY}`
      }
    });
  } catch (error) {
    console.error(
      "TMDB ERROR:",
      error.message
    );

    /*
     Fallback for v3 API key authentication
    */

    try {
      const fallbackUrl =
        `${endpoint}?api_key=${encodeURIComponent(
          TMDB_API_KEY
        )}&language=he-IL`;

      return await getJson(
        fallbackUrl
      );
    } catch (fallbackError) {
      console.error(
        "TMDB FALLBACK ERROR:",
        fallbackError.message
      );

      return null;
    }
  }
}

/* =========================================================
   GET HEBREW TITLE
========================================================= */

async function getHebrewTitle(
  type,
  meta
) {
  const tmdbId =
    meta.moviedb_id ||
    meta.tmdb_id ||
    meta.tmdbId ||
    null;

  console.log(
    "TMDB ID:",
    tmdbId
  );

  if (!tmdbId) {
    return {
      title: null,
      tmdb: null,
      reason:
        "No TMDB ID in Cinemeta"
    };
  }

  const tmdb =
    await getTMDBDetails(
      type,
      tmdbId
    );

  if (!tmdb) {
    return {
      title: null,
      tmdb: null,
      reason:
        "TMDB request failed"
    };
  }

  const hebrewTitle =
    type === "series"
      ? (
          tmdb.name ||
          tmdb.original_name ||
          null
        )
      : (
          tmdb.title ||
          tmdb.original_title ||
          null
        );

  console.log(
    "TMDB HEBREW TITLE:",
    hebrewTitle
  );

  return {
    title: hebrewTitle,
    tmdb
  };
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

  return await getJson(url);
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

  console.log(
    "TVNETIL SEARCH:",
    type,
    query
  );

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

      /*
       Exact / contained match
      */

      if (
        name === wanted ||
        name.includes(wanted) ||
        wanted.includes(name)
      ) {
        results.push(item);
        continue;
      }

      /*
       Word match
      */

      const wantedWords =
        wanted
          .split(" ")
          .filter(
            word => word.length >= 2
          );

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

  /*
   Remove duplicates
  */

  const unique =
    new Map();

  for (const item of results) {
    if (item?.id) {
      unique.set(
        item.id,
        item
      );
    }
  }

  return [...unique.values()];
}

/* =========================================================
   TVNETIL MATCH
========================================================= */

function scoreTVNetilItem(
  item,
  hebrewTitle,
  wantedYear
) {
  const itemName =
    normalize(
      item.name ||
      item.title
    );

  const wanted =
    normalize(
      hebrewTitle
    );

  if (
    !itemName ||
    !wanted
  ) {
    return -1;
  }

  let score = 0;

  if (
    itemName === wanted
  ) {
    score += 300;
  } else if (
    itemName.includes(wanted)
  ) {
    score += 220;
  } else if (
    wanted.includes(itemName)
  ) {
    score += 180;
  }

  const wantedWords =
    wanted
      .split(" ")
      .filter(
        x => x.length >= 2
      );

  const itemWords =
    new Set(
      itemName.split(" ")
    );

  for (const word of wantedWords) {
    if (
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
      score += 100;
    } else if (
      Math.abs(
        wantedYear - itemYear
      ) === 1
    ) {
      score += 20;
    } else {
      score -= 100;
    }
  }

  return score;
}

/* =========================================================
   FIND TVNETIL ITEM
========================================================= */

async function findTVNetilByHebrew(
  type,
  hebrewTitle,
  wantedYear
) {
  console.log(
    "FIND TVNETIL BY HEBREW:",
    hebrewTitle,
    wantedYear
  );

  /*
   First try direct catalog search
  */

  let results =
    await searchTVNetilCatalog(
      type,
      hebrewTitle
    );

  console.log(
    "TVNETIL SEARCH RESULTS:",
    results.length
  );

  /*
   If no result, try removing year
  */

  if (
    results.length === 0
  ) {
    const withoutYear =
      String(hebrewTitle)
        .replace(
          /\s*\(\d{4}\)\s*$/,
          ""
        )
        .trim();

    if (
      withoutYear &&
      withoutYear !==
        hebrewTitle
    ) {
      console.log(
        "TVNETIL SEARCH WITHOUT YEAR:",
        withoutYear
      );

      results =
        await searchTVNetilCatalog(
          type,
          withoutYear
        );
    }
  }

  if (
    results.length === 0
  ) {
    return null;
  }

  /*
   Choose best result
  */

  let best = null;
  let bestScore = -1;

  for (const item of results) {
    const current =
      scoreTVNetilItem(
        item,
        hebrewTitle,
        wantedYear
      );

    console.log(
      "TVNETIL CANDIDATE:",
      item.id,
      item.name ||
        item.title,
      current
    );

    if (
      current > bestScore
    ) {
      bestScore =
        current;

      best = item;
    }
  }

  /*
   We know TVNetil search itself
   found the title, so don't require
   the old 100-point English match.
  */

  if (!best) {
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
    "FAVEZ0NE SEARCH:",
    title
  );

  const body =
    new URLSearchParams({
      srch: title,
      "submit.x": "0",
      "submit.y": "0"
    }).toString();

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

  console.log(
    "FAVEZ0NE RESPONSE:",
    html.length
  );

  return html;
}

/* =========================================================
   HTML DECODE
========================================================= */

function decodeHtml(
  value
) {
  return String(value || "")
    .replace(
      /&amp;/gi,
      "&"
    )
    .replace(
      /&quot;/gi,
      '"'
    )
    .replace(
      /&#39;/gi,
      "'"
    )
    .replace(
      /&apos;/gi,
      "'"
    )
    .replace(
      /&lt;/gi,
      "<"
    )
    .replace(
      /&gt;/gi,
      ">"
    )
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

  /*
   href URLs
  */

  const hrefRegex =
    /href\s*=\s*["']([^"']+)["']/gi;

  let match;

  while (
    (match =
      hrefRegex.exec(html)) !==
    null
  ) {
    let url =
      decodeHtml(
        match[1]
      )
        .replace(
          /[\r\n\t]/g,
          ""
        )
        .trim();

    if (
      /^https?:\/\//i.test(url)
    ) {
      results.push(url);
    }
  }

  /*
   Direct URLs
  */

  const directRegex =
    /https?:\/\/[^\s"'<>\\]+/gi;

  while (
    (match =
      directRegex.exec(html)) !==
    null
  ) {
    let url =
      decodeHtml(
        match[0]
      )
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
    [...new Set(results)];

  /*
   Supported hosts
  */

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
   HOST NAME
========================================================= */

function hostName(
  url
) {
  try {
    const host =
      new URL(url)
        .hostname
        .toLowerCase();

    if (
      host.includes(
        "pixeldrain"
      )
    ) {
      return "Pixeldrain";
    }

    if (
      host.includes(
        "gofile"
      )
    ) {
      return "Gofile";
    }

    if (
      host.includes(
        "mega.nz"
      )
    ) {
      return "Mega";
    }

    if (
      host.includes(
        "1fichier"
      )
    ) {
      return "1fichier";
    }

    if (
      host.includes(
        "send.now"
      )
    ) {
      return "Send.now";
    }

    if (
      host.includes(
        "usersdrive"
      )
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
  urls,
  extraTitle = ""
) {
  return urls.map(
    url => {

      const host =
        hostName(url);

      return {
        name:
          "TVNetil",

        title:
          extraTitle
            ? `${host} | ${extraTitle}`
            : `${host} | TVNetil`,

        url,

        behaviorHints: {
          notWebReady: true
        }
      };
    }
  );
}

/* =========================================================
   FAVE TITLE
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
   Keep exact TVNetil title.
   Do NOT translate.
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
   STREAM ENDPOINT
========================================================= */

app.get(
  "/stream/:type/:id.json",
  async (req, res) => {

    const {
      type,
      id
    } = req.params;

    console.log(
      "===================================="
    );

    console.log(
      "STREAM REQUEST:",
      type,
      id
    );

    /*
     Series episode information
    */

    const season =
      req.query.season
        ? Number(
            req.query.season
          )
        : null;

    const episode =
      req.query.episode
        ? Number(
            req.query.episode
          )
        : null;

    console.log(
      "SEASON:",
      season,
      "EPISODE:",
      episode
    );

    if (
      !["movie", "series"]
        .includes(type)
    ) {
      return res.json({
        streams: []
      });
    }

    if (
      !/^tt\d+$/.test(id)
    ) {
      return res.json({
        streams: []
      });
    }

    try {

      /*
       1. CINEMETA
      */

      const cinemeta =
        await getCinemeta(
          type,
          id
        );

      const meta =
        cinemeta?.meta;

      if (
        !meta?.name
      ) {
        console.log(
          "NO CINEMETA META"
        );

        return res.json({
          streams: []
        });
      }

      const wantedYear =
        extractYear(
          meta.releaseInfo ||
          meta.releaseDate ||
          meta.year ||
          meta.firstAirDate
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

      /*
       2. TMDB HEBREW
      */

      const hebrew =
        await getHebrewTitle(
          type,
          meta
        );

      if (
        !hebrew.title
      ) {
        console.log(
          "NO HEBREW TMDB TITLE"
        );

        return res.json({
          streams: []
        });
      }

      /*
       3. TVNETIL SEARCH
      */

      const match =
        await findTVNetilByHebrew(
          type,
          hebrew.title,
          wantedYear
        );

      if (
        !match?.item
      ) {
        console.log(
          "NO TVNETIL HEBREW MATCH"
        );

        return res.json({
          streams: []
        });
      }

      const item =
        match.item;

      const tvTitle =
        item.name ||
        item.title;

      const tvYear =
        getItemYear(item);

      /*
       4. EXACT TVNETIL TITLE
      */

      const faveTitle =
        buildFaveTitle(
          tvTitle,
          tvYear
        );

      console.log(
        "TVNETIL EXACT TITLE:",
        tvTitle
      );

      console.log(
        "FAVEZONE TITLE:",
        faveTitle
      );

      /*
       5. FAVEZONE
      */

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

      /*
       Fallback without year
      */

      if (
        urls.length === 0 &&
        tvYear
      ) {

        const withoutYear =
          String(tvTitle)
            .replace(
              /\s*\(\d{4}\)\s*$/,
              ""
            )
            .trim();

        if (
          withoutYear &&
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

          searchUsed =
            withoutYear;
        }
      }

      /*
       6. SERIES
      */

      let streamTitle =
        "TVNetil";

      if (
        type === "series"
      ) {

        if (
          Number.isInteger(
            season
          ) &&
          Number.isInteger(
            episode
          )
        ) {
          streamTitle =
            `${tvTitle} | S${String(
              season
            ).padStart(2, "0")}E${String(
              episode
            ).padStart(2, "0")}`;
        } else {
          streamTitle =
            `${tvTitle} | TVNetil`;
        }
      }

      /*
       7. STREAMS
      */

      const streams =
        cleanStreams(
          urls,
          streamTitle
        );

      console.log(
        "FAVEZONE LINKS:",
        urls
      );

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
          "Use ?q=movie or series name"
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
                getItemYear(item),

              type:
                item.type ||
                type
            })
          )
      });

    } catch (error) {

      return res.status(
        500
      ).json({
        success: false,

        error:
          error.stack ||
          error.message
      });
    }
  }
);

/* =========================================================
   DEBUG
========================================================= */

app.get(
  "/debug/:type/:id.json",
  async (req, res) => {

    const {
      type,
      id
    } = req.params;

    try {

      if (
        !["movie", "series"]
          .includes(type)
      ) {
        return res.status(
          400
        ).json({
          success: false,
          error:
            "Invalid type"
        });
      }

      if (
        !/^tt\d+$/.test(id)
      ) {
        return res.status(
          400
        ).json({
          success: false,
          error:
            "Invalid IMDb ID"
        });
      }

      /*
       CINEMETA
      */

      const cinemeta =
        await getCinemeta(
          type,
          id
        );

      const meta =
        cinemeta?.meta;

      if (
        !meta?.name
      ) {
        return res.json({
          success: false,

          step:
            "cinemeta"
        });
      }

      const wantedYear =
        extractYear(
          meta.releaseInfo ||
          meta.releaseDate ||
          meta.year ||
          meta.firstAirDate
        );

      /*
       TMDB
      */

      const hebrew =
        await getHebrewTitle(
          type,
          meta
        );

      if (
        !hebrew.title
      ) {
        return res.json({

          success: false,

          step:
            "tmdb-hebrew",

          cinemeta: {
            id,
            name:
              meta.name,
            tmdb:
              meta.moviedb_id ||
              null,
            year:
              wantedYear
          },

          message:
            hebrew.reason ||
            "No Hebrew TMDB title"
        });
      }

      /*
       TVNETIL
      */

      const match =
        await findTVNetilByHebrew(
          type,
          hebrew.title,
          wantedYear
        );

      if (
        !match?.item
      ) {
        return res.json({

          success: false,

          step:
            "tvnetil-hebrew-search",

          cinemeta: {
            id,
            name:
              meta.name,
            tmdb:
              meta.moviedb_id ||
              null,
            year:
              wantedYear
          },

          tmdb: {
            id:
              meta.moviedb_id ||
              null,

            hebrewTitle:
              hebrew.title
          },

          message:
            "TMDB Hebrew title found, but TVNetil did not return a matching title"
        });
      }

      const item =
        match.item;

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

      /*
       FAVEZONE
      */

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
        urls.length === 0 &&
        tvYear
      ) {

        const withoutYear =
          String(tvTitle)
            .replace(
              /\s*\(\d{4}\)\s*$/,
              ""
            )
            .trim();

        if (
          withoutYear &&
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

      const streams =
        cleanStreams(
          urls,
          tvTitle
        );

      /*
       DEBUG RESPONSE
      */

      return res.json({

        success: true,

        cinemeta: {
          id,

          name:
            meta.name,

          originalName:
            meta.originalName ||
            meta.originalTitle ||
            null,

          tmdb:
            meta.moviedb_id ||
            null,

          year:
            wantedYear
        },

        tmdb: {
          id:
            meta.moviedb_id ||
            null,

          hebrewTitle:
            hebrew.title,

          originalTitle:
            hebrew.tmdb?.original_title ||
            hebrew.tmdb?.original_name ||
            null,

          tmdbName:
            hebrew.tmdb?.title ||
            hebrew.tmdb?.name ||
            null
        },

        tvnetil: {
          id:
            item.id,

          name:
            tvTitle,

          year:
            tvYear,

          score:
            match.score
        },

        favezone: {
          searchTitle:
            searchUsed,

          exactTVNetilTitle:
            faveTitle,

          linkCount:
            urls.length,

          links:
            urls
        },

        streams

      });

    } catch (error) {

      return res.status(
        500
      ).json({

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

      return res.status(
        500
      ).json({

        success: false,

        error:
          error.stack ||
          error.message

      });
    }
  }
);

/* =========================================================
   TVNETIL CATALOG LIST
========================================================= */

app.get(
  "/list-tvnetil",
  async (req, res) => {

    const type =
      req.query.type === "series"
        ? "series"
        : "movie";

    const skip =
      Math.max(
        0,
        Number(
          req.query.skip || 0
        )
      );

    try {

      const data =
        await getCatalog(
          type,
          skip
        );

      const metas =
        Array.isArray(
          data?.metas
        )
          ? data.metas
          : [];

      return res.json({

        success: true,

        type,

        skip,

        count:
          metas.length,

        movies:
          metas.map(
            item => ({

              id:
                item.id,

              name:
                item.name ||
                item.title,

              year:
                getItemYear(item),

              type:
                item.type ||
                type

            })
          )

      });

    } catch (error) {

      return res.status(
        500
      ).json({

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

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  () => {

    console.log(
      `TVNetil Direct Streams v1.6.0 started on ${PORT}`
    );
  }
);
