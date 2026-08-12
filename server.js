import express from "express";

const app = express();

/* =========================================================
   CONFIG
========================================================= */

const TV = "https://tvnetil-addon.vercel.app";
const CM = "https://v3-cinemeta.strem.io/meta";
const FAVE = "https://www.favez0ne.net/search.php";

const TMDB_API_KEY =
  "39e6950a7ffa18878e6428b3b708351f";

/* =========================================================
   MANIFEST
========================================================= */

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "1.6.0",
  name: "TVNetil Direct Streams",
  description:
    "TVNetil Hebrew title -> Favez0ne streams for Nuvio/Cinemeta",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"]
};

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
   TMDB
========================================================= */

async function findTMDBByIMDb(
  imdbId,
  type
) {
  console.log(
    "TMDB FIND:",
    imdbId,
    type
  );

  const url =
    `https://api.themoviedb.org/3/find/` +
    `${encodeURIComponent(imdbId)}` +
    `?api_key=${encodeURIComponent(TMDB_API_KEY)}` +
    `&external_source=imdb_id` +
    `&language=he-IL`;

  const data =
    await getJson(url);

  console.log(
    "TMDB RESULT:",
    JSON.stringify(data)
  );

  if (type === "movie") {
    return data.movie_results?.[0] || null;
  }

  if (type === "series") {
    return data.tv_results?.[0] || null;
  }

  return null;
}

/* =========================================================
   TMDB HEBREW TITLE
========================================================= */

async function getHebrewTitle(
  imdbId,
  type,
  cinemetaMeta
) {
  let tmdb = null;

  try {
    tmdb =
      await findTMDBByIMDb(
        imdbId,
        type
      );
  } catch (error) {
    console.error(
      "TMDB ERROR:",
      error.message
    );
  }

  let title = null;

  if (tmdb) {
    if (type === "movie") {
      title =
        tmdb.title ||
        tmdb.original_title ||
        null;
    }

    if (type === "series") {
      title =
        tmdb.name ||
        tmdb.original_name ||
        null;
    }
  }

  /*
   If TMDB did not return a Hebrew title,
   don't accidentally search FaveZone with
   the English Cinemeta title.
  */

  if (
    title &&
    /[\u0590-\u05FF]/.test(title)
  ) {
    return {
      title,
      tmdb
    };
  }

  /*
   Some TMDB records may not contain Hebrew.
   Try TMDB details explicitly with he-IL.
  */

  if (tmdb?.id) {
    try {
      const endpoint =
        type === "movie"
          ? "movie"
          : "tv";

      const details =
        await getJson(
          `https://api.themoviedb.org/3/` +
          `${endpoint}/${tmdb.id}` +
          `?api_key=${encodeURIComponent(TMDB_API_KEY)}` +
          `&language=he-IL`
        );

      const translated =
        type === "movie"
          ? details.title
          : details.name;

      if (
        translated &&
        /[\u0590-\u05FF]/.test(
          translated
        )
      ) {
        return {
          title: translated,
          tmdb: {
            ...tmdb,
            ...details
          }
        };
      }
    } catch (error) {
      console.error(
        "TMDB DETAILS ERROR:",
        error.message
      );
    }
  }

  /*
   Final fallback:
   Cinemeta may itself contain Hebrew.
  */

  const cinemetaCandidates = [
    cinemetaMeta?.name,
    cinemetaMeta?.originalName,
    cinemetaMeta?.originalTitle
  ].filter(Boolean);

  const hebrewCandidate =
    cinemetaCandidates.find(
      x =>
        /[\u0590-\u05FF]/.test(
          String(x)
        )
    );

  if (hebrewCandidate) {
    return {
      title: hebrewCandidate,
      tmdb
    };
  }

  return {
    title: null,
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

      /*
       Exact / contains
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
       Hebrew word matching
      */

      const wantedWords =
        wanted
          .split(" ")
          .filter(
            x => x.length >= 2
          );

      const matched =
        wantedWords.filter(
          word =>
            name.includes(word)
        ).length;

      if (
        wantedWords.length > 0 &&
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
   TVNETIL MATCH FROM HEBREW TITLE
========================================================= */

async function findTVNetilHebrewItem(
  type,
  hebrewTitle,
  wantedYear
) {
  console.log(
    "TVNETIL HEBREW SEARCH:",
    hebrewTitle,
    wantedYear
  );

  const results =
    await searchTVNetilCatalog(
      type,
      hebrewTitle,
      100
    );

  if (!results.length) {
    return null;
  }

  const wanted =
    normalize(hebrewTitle);

  let best = null;
  let bestScore = -1;

  for (const item of results) {
    const name =
      normalize(
        item.name ||
        item.title
      );

    let current = 0;

    if (name === wanted) {
      current += 300;
    } else if (
      name.includes(wanted) ||
      wanted.includes(name)
    ) {
      current += 200;
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
        current += 100;
      } else if (
        Math.abs(
          wantedYear - itemYear
        ) === 1
      ) {
        current += 20;
      } else {
        current -= 100;
      }
    }

    if (
      current > bestScore
    ) {
      bestScore = current;
      best = item;
    }
  }

  console.log(
    "TVNETIL BEST:",
    best?.id,
    best?.name,
    bestScore
  );

  return best;
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
    "FAVEZ0NE RESPONSE LENGTH:",
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
   href links
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
      /^https?:\/\//i.test(
        url
      )
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
    [
      ...new Set(
        results
      )
    ];

  /*
   Allowed hosts
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
   HOST
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
  urls
) {
  return urls.map(
    url => {
      const host =
        hostName(url);

      return {
        name:
          "TVNetil",

        title:
          `${host} | TVNetil`,

        url,

        behaviorHints: {
          notWebReady: true
        }
      };
    }
  );
}

/* =========================================================
   STREAM ENDPOINT
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
      "STREAM REQUEST:",
      type,
      id
    );

    if (
      ![
        "movie",
        "series"
      ].includes(type) ||
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
        await getJson(
          `${CM}/${type}/${id}.json`
        );

      const meta =
        cinemeta?.meta;

      if (!meta) {
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
        "CINEMETA:",
        meta.name,
        wantedYear
      );

      /*
       2. TMDB -> HEBREW
      */

      const hebrew =
        await getHebrewTitle(
          id,
          type,
          meta
        );

      console.log(
        "HEBREW TITLE:",
        hebrew.title
      );

      if (!hebrew.title) {

        console.log(
          "NO HEBREW TMDB TITLE"
        );

        return res.json({
          streams: []
        });
      }

      /*
       3. TVNETIL
      */

      const tvItem =
        await findTVNetilHebrewItem(
          type,
          hebrew.title,
          wantedYear
        );

      if (!tvItem?.id) {

        console.log(
          "NO TVNETIL HEBREW MATCH"
        );

        return res.json({
          streams: []
        });
      }

      const tvTitle =
        tvItem.name ||
        tvItem.title;

      const tvYear =
        getItemYear(
          tvItem
        );

      /*
       4. FAVEZONE
      */

      let html =
        await searchFavez0ne(
          tvTitle
        );

      let urls =
        extractFavezLinks(
          html
        );

      let searchUsed =
        tvTitle;

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

        console.log(
          "FAVE FALLBACK:",
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

      const streams =
        cleanStreams(
          urls
        );

      console.log(
        "FAVE SEARCH:",
        searchUsed
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
   DEBUG
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
        ![
          "movie",
          "series"
        ].includes(type) ||
        !/^tt\d+$/.test(id)
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Invalid type or IMDb ID"
        });
      }

      /*
       CINEMETA
      */

      const cinemeta =
        await getJson(
          `${CM}/${type}/${id}.json`
        );

      const meta =
        cinemeta?.meta;

      if (!meta) {
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
          meta.year
        );

      /*
       TMDB
      */

      const hebrew =
        await getHebrewTitle(
          id,
          type,
          meta
        );

      if (!hebrew.title) {
        return res.json({

          success: false,

          step:
            "tmdb-hebrew",

          cinemeta: {
            id,
            name:
              meta.name,
            year:
              wantedYear
          },

          tmdb:
            hebrew.tmdb || null,

          message:
            "TMDB did not return a Hebrew title"
        });
      }

      /*
       TVNETIL
      */

      const tvItem =
        await findTVNetilHebrewItem(
          type,
          hebrew.title,
          wantedYear
        );

      if (!tvItem?.id) {
        return res.json({

          success: false,

          step:
            "tvnetil-hebrew-match",

          cinemeta: {
            id,
            name:
              meta.name,
            year:
              wantedYear
          },

          tmdb: {
            id:
              hebrew.tmdb?.id ||
              null,

            title:
              hebrew.title
          },

          message:
            "Hebrew title found, but no TVNetil match"
        });
      }

      const tvTitle =
        tvItem.name ||
        tvItem.title;

      const tvYear =
        getItemYear(
          tvItem
        );

      /*
       FAVEZONE
      */

      let html =
        await searchFavez0ne(
          tvTitle
        );

      let urls =
        extractFavezLinks(
          html
        );

      let searchUsed =
        tvTitle;

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

      const streams =
        cleanStreams(
          urls
        );

      return res.json({

        success: true,

        cinemeta: {
          id,
          name:
            meta.name,
          year:
            wantedYear
        },

        tmdb: {
          id:
            hebrew.tmdb?.id ||
            null,

          title:
            hebrew.title,

          originalTitle:
            hebrew.tmdb?.original_title ||
            hebrew.tmdb?.original_name ||
            null
        },

        tvnetil: {
          id:
            tvItem.id,

          name:
            tvTitle,

          year:
            tvYear
        },

        favezone: {

          searchTitle:
            searchUsed,

          linkCount:
            urls.length,

          links:
            urls
        },

        streams

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
   SEARCH TVNETIL
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
                getItemYear(
                  item
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
   LIST TVNETIL
========================================================= */

app.get(
  "/list-tvnetil",
  async (
    req,
    res
  ) => {

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
          data.metas
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
                getItemYear(
                  item
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
