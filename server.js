import express from "express";

const app = express();

const TV = "https://tvnetil-addon.vercel.app";
const CM = "https://v3-cinemeta.strem.io/meta";
const FAVE = "https://www.favez0ne.net/search.php";

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "1.6.0",
  name: "TVNetil Direct Streams",
  description: "Hebrew TVNetil -> FaveZ0ne streams for Nuvio",
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
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",

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
      `Invalid JSON from ${url}: ${text.slice(0, 300)}`
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
  const m = String(value || "")
    .match(/\b(19|20)\d{2}\b/);

  return m ? Number(m[0]) : null;
}

/* =========================================================
   CINEMETA
========================================================= */

async function getCinemeta(type, id) {
  return await getJson(
    `${CM}/${type}/${id}.json`
  );
}

/*
  Collect every potentially useful title.
  Hebrew titles are preferred if Cinemeta supplies them.
*/

function getCinemetaNames(meta) {
  const names = [];

  const candidates = [
    meta.name,
    meta.title,
    meta.name_he,
    meta.title_he,
    meta.hebrewName,
    meta.hebrewTitle,
    meta.originalName,
    meta.originalTitle
  ];

  for (const value of candidates) {
    if (!value) continue;

    const s = String(value).trim();

    if (!s) continue;

    if (!names.includes(s)) {
      names.push(s);
    }
  }

  return names;
}

/*
  Pick Hebrew-looking title if available.
*/

function getHebrewName(meta) {
  const candidates = [
    meta.name_he,
    meta.title_he,
    meta.hebrewName,
    meta.hebrewTitle
  ];

  for (const value of candidates) {
    if (
      value &&
      /[\u0590-\u05FF]/.test(String(value))
    ) {
      return String(value).trim();
    }
  }

  /*
    Sometimes the regular name itself is Hebrew.
  */

  for (const value of [
    meta.name,
    meta.title
  ]) {
    if (
      value &&
      /[\u0590-\u05FF]/.test(String(value))
    ) {
      return String(value).trim();
    }
  }

  return null;
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
    `${TV}/catalog/${type}/${catalog}.json?skip=${skip}`;

  console.log("TVNETIL CATALOG:", url);

  return await getJson(url);
}

/* =========================================================
   TVNETIL SEARCH
========================================================= */

async function searchTVNetil(type, query) {
  const wanted = normalize(query);

  if (!wanted) {
    return [];
  }

  const results = [];

  /*
    Search catalog pages.
    We stop when the requested title is found.
  */

  for (
    let skip = 0;
    skip <= 10000;
    skip += 100
  ) {
    let data;

    try {
      data = await getCatalog(type, skip);
    } catch (e) {
      console.error(
        "TVNETIL SEARCH ERROR:",
        e.message
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
      const itemName =
        item.name ||
        item.title ||
        "";

      const normalized =
        normalize(itemName);

      if (!normalized) {
        continue;
      }

      /*
        Exact / contains matches.
      */

      if (
        normalized === wanted ||
        normalized.includes(wanted) ||
        wanted.includes(normalized)
      ) {
        results.push(item);
        continue;
      }

      /*
        Word match.
      */

      const words =
        wanted
          .split(" ")
          .filter(x => x.length >= 2);

      if (!words.length) {
        continue;
      }

      const matched =
        words.filter(word =>
          normalized.includes(word)
        ).length;

      if (
        matched >=
        Math.ceil(words.length * 0.6)
      ) {
        results.push(item);
      }
    }

    if (results.length > 0) {
      break;
    }

    if (metas.length < 100) {
      break;
    }
  }

  console.log(
    "TVNETIL SEARCH RESULT:",
    results.map(x => ({
      id: x.id,
      name: x.name || x.title
    }))
  );

  return results;
}

/* =========================================================
   TVNETIL TITLE
========================================================= */

async function findTVNetil(type, names) {
  /*
    Hebrew names first.
  */

  const ordered = [
    ...names.filter(x =>
      /[\u0590-\u05FF]/.test(x)
    ),
    ...names.filter(x =>
      !/[\u0590-\u05FF]/.test(x)
    )
  ];

  for (const name of ordered) {
    console.log(
      "TRY TVNETIL SEARCH:",
      name
    );

    const results =
      await searchTVNetil(
        type,
        name
      );

    if (results.length) {
      const item = results[0];

      console.log(
        "TVNETIL MATCH:",
        item.id,
        item.name || item.title
      );

      return item;
    }
  }

  return null;
}

/* =========================================================
   FAVEZ0NE
========================================================= */

async function searchFavez0ne(title) {
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

  return await getText(
    FAVE,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded; charset=windows-1255",

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
        String.fromCharCode(Number(n))
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
   FAVEZ0NE LINKS
========================================================= */

function extractFavezLinks(html) {
  const links = [];

  /*
    href links
  */

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
      links.push(url);
    }
  }

  /*
    Direct URLs
  */

  const directRegex =
    /https?:\/\/[^\s"'<>\\]+/gi;

  while (
    (match = directRegex.exec(html)) !== null
  ) {
    const url =
      decodeHtml(match[0])
        .replace(/[\r\n\t]/g, "")
        .replace(/[),.;]+$/, "")
        .trim();

    links.push(url);
  }

  const unique =
    [...new Set(links)];

  /*
    Known video hosts.
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

  return unique.filter(url => {
    try {
      const host =
        new URL(url)
          .hostname
          .toLowerCase();

      return allowed.some(
        domain =>
          host === domain ||
          host.endsWith("." + domain)
      );
    } catch {
      return false;
    }
  });
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

    if (host.includes("pixeldrain"))
      return "Pixeldrain";

    if (host.includes("gofile"))
      return "Gofile";

    if (host.includes("mega.nz"))
      return "Mega";

    if (host.includes("1fichier"))
      return "1fichier";

    if (host.includes("send.now"))
      return "Send.now";

    if (host.includes("usersdrive"))
      return "UsersDrive";

    return host;

  } catch {
    return "FaveZ0ne";
  }
}

/* =========================================================
   STREAM OBJECTS
========================================================= */

function makeStreams(urls, title) {
  return urls.map(url => ({
    name: "TVNetil",
    title:
      `${hostName(url)} | ${title}`,
    url,

    behaviorHints: {
      notWebReady: true
    }
  }));
}

/* =========================================================
   SERIES EPISODE
========================================================= */

function parseSeriesId(id) {
  /*
    Stremio/Nuvio usually uses:

    tt1234567:1:3

    or

    tt1234567:1:3
  */

  const parts =
    String(id).split(":");

  return {
    imdbId: parts[0],
    season:
      parts[1]
        ? Number(parts[1])
        : null,
    episode:
      parts[2]
        ? Number(parts[2])
        : null
  };
}

/* =========================================================
   FAVE SEARCH VARIANTS
========================================================= */

async function searchFaveVariants(
  tvTitle,
  year,
  season,
  episode
) {
  const searches = [];

  /*
    First:
    exact TVNetil title
  */

  searches.push(
    tvTitle
  );

  /*
    Without year
  */

  const withoutYear =
    String(tvTitle)
      .replace(
        /\s*\(\d{4}\)\s*$/,
        ""
      )
      .trim();

  if (
    withoutYear &&
    withoutYear !== tvTitle
  ) {
    searches.push(
      withoutYear
    );
  }

  /*
    Series:
    try season / episode formats.
  */

  if (
    season !== null &&
    episode !== null
  ) {
    searches.unshift(
      `${withoutYear} עונה ${season} פרק ${episode}`
    );

    searches.unshift(
      `${withoutYear} ${season}x${episode}`
    );
  }

  for (const query of searches) {
    try {
      console.log(
        "FAVE SEARCH TRY:",
        query
      );

      const html =
        await searchFavez0ne(
          query
        );

      const urls =
        extractFavezLinks(
          html
        );

      if (urls.length) {
        return {
          query,
          urls
        };
      }

    } catch (e) {
      console.error(
        "FAVE SEARCH ERROR:",
        e.message
      );
    }
  }

  return {
    query:
      searches[0] || tvTitle,
    urls: []
  };
}

/* =========================================================
   STREAM
========================================================= */

app.get(
  "/stream/:type/:id.json",
  async (req, res) => {

    const type =
      req.params.type;

    const rawId =
      req.params.id;

    console.log(
      "================================"
    );

    console.log(
      "STREAM REQUEST:",
      type,
      rawId
    );

    if (
      !["movie", "series"]
        .includes(type)
    ) {
      return res.json({
        streams: []
      });
    }

    try {

      /*
        SERIES ID
      */

      let imdbId =
        rawId;

      let season = null;
      let episode = null;

      if (type === "series") {
        const parsed =
          parseSeriesId(rawId);

        imdbId =
          parsed.imdbId;

        season =
          parsed.season;

        episode =
          parsed.episode;
      }

      if (
        !/^tt\d+$/.test(imdbId)
      ) {
        return res.json({
          streams: []
        });
      }

      /*
        CINEMETA
      */

      const cinemeta =
        await getCinemeta(
          type,
          imdbId
        );

      const meta =
        cinemeta?.meta;

      if (!meta) {
        return res.json({
          streams: []
        });
      }

      const names =
        getCinemetaNames(meta);

      /*
        IMPORTANT:
        Hebrew first.
      */

      const hebrewName =
        getHebrewName(meta);

      if (
        hebrewName &&
        !names.includes(hebrewName)
      ) {
        names.unshift(
          hebrewName
        );
      }

      console.log(
        "CINEMETA NAMES:",
        names
      );

      console.log(
        "HEBREW NAME:",
        hebrewName
      );

      /*
        TVNETIL
      */

      const item =
        await findTVNetil(
          type,
          names
        );

      if (!item?.id) {

        console.log(
          "NO TVNETIL RESULT"
        );

        return res.json({
          streams: []
        });
      }

      /*
        THIS IS THE IMPORTANT PART:

        Use EXACT TVNetil title
        for FaveZ0ne.
      */

      const tvTitle =
        item.name ||
        item.title ||
        "";

      const tvYear =
        extractYear(
          tvTitle
        );

      console.log(
        "EXACT TVNETIL TITLE:",
        tvTitle
      );

      /*
        FAVEZ0NE
      */

      const fave =
        await searchFaveVariants(
          tvTitle,
          tvYear,
          season,
          episode
        );

      const streams =
        makeStreams(
          fave.urls,
          tvTitle
        );

      console.log(
        "FAVE QUERY:",
        fave.query
      );

      console.log(
        "FAVE LINKS:",
        fave.urls
      );

      console.log(
        "STREAM COUNT:",
        streams.length
      );

      console.log(
        "================================"
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
  async (req, res) => {

    const type =
      req.params.type;

    const rawId =
      req.params.id;

    try {

      let imdbId =
        rawId;

      let season = null;
      let episode = null;

      if (type === "series") {
        const parsed =
          parseSeriesId(rawId);

        imdbId =
          parsed.imdbId;

        season =
          parsed.season;

        episode =
          parsed.episode;
      }

      const cinemeta =
        await getCinemeta(
          type,
          imdbId
        );

      const meta =
        cinemeta?.meta;

      if (!meta) {
        return res.json({
          success: false,
          step: "cinemeta"
        });
      }

      const names =
        getCinemetaNames(meta);

      const hebrewName =
        getHebrewName(meta);

      if (
        hebrewName &&
        !names.includes(hebrewName)
      ) {
        names.unshift(
          hebrewName
        );
      }

      /*
        TVNETIL
      */

      const item =
        await findTVNetil(
          type,
          names
        );

      if (!item?.id) {
        return res.json({
          success: false,

          step:
            "tvnetil-search",

          cinemeta: {
            id: imdbId,
            names,
            hebrewName
          },

          message:
            "TVNetil search returned no result"
        });
      }

      const tvTitle =
        item.name ||
        item.title ||
        "";

      /*
        FAVE
      */

      const fave =
        await searchFaveVariants(
          tvTitle,
          extractYear(tvTitle),
          season,
          episode
        );

      const streams =
        makeStreams(
          fave.urls,
          tvTitle
        );

      return res.json({

        success: true,

        request: {
          type,
          rawId,
          imdbId,
          season,
          episode
        },

        cinemeta: {
          id: imdbId,
          names,
          hebrewName
        },

        tvnetil: {
          id: item.id,
          name: tvTitle,
          type: item.type || type
        },

        favezone: {
          searchTitle:
            fave.query,

          linkCount:
            fave.urls.length,

          links:
            fave.urls
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
   MANUAL TVNETIL SEARCH
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
        await searchTVNetil(
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
          results.map(item => ({
            id: item.id,
            name:
              item.name ||
              item.title,
            type:
              item.type || type
          }))

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

    const q =
      String(
        req.query.q ||
        "בלאגן ביער"
      );

    try {

      const html =
        await searchFavez0ne(q);

      const links =
        extractFavezLinks(html);

      return res.json({

        success: true,

        query: q,

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
