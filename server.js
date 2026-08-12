import express from "express";

const app = express();

const TV = "https://tvnetil-addon.vercel.app";
const CM = "https://v3-cinemeta.strem.io/meta";
const FAVE_SEARCH = "https://www.favez0ne.net/search.php";
const FAVE_HOME = "https://www.favez0ne.net";

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "1.6.0",
  name: "TVNetil Direct Streams",
  description: "TVNetil titles -> Favez0ne streams for Nuvio/Cinemeta",
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
  return (
    extractYear(item.releaseInfo) ||
    extractYear(item.releaseDate) ||
    extractYear(item.year) ||
    extractYear(item.name) ||
    extractYear(item.title) ||
    extractYear(item.description) ||
    null
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
    `${TV}/catalog/${type}/${catalog}.json?skip=${skip}`;

  console.log("TVNETIL CATALOG:", url);

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
      data = await getCatalog(type, skip);
    } catch (error) {
      console.error(
        "TVNETIL SEARCH ERROR:",
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

      const exact =
        names.some(name =>
          name === wanted ||
          name.includes(wanted) ||
          wanted.includes(name)
        );

      if (exact) {
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

      const bestName =
        names[0] || "";

      const matched =
        wantedWords.filter(word =>
          bestName.includes(word)
        ).length;

      if (
        matched >=
        Math.ceil(wantedWords.length * 0.6)
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
   TVNETIL MATCH SCORE
========================================================= */

function score(item, wantedNames, wantedYear) {
  const itemName = normalize(
    item.name ||
    item.title ||
    item.originalName ||
    item.originalTitle
  );

  if (!itemName) {
    return -1;
  }

  let best = -1;

  for (const wantedName of wantedNames) {
    const wanted = normalize(wantedName);

    if (!wanted) {
      continue;
    }

    let result = 0;

    if (itemName === wanted) {
      result += 200;
    } else if (
      itemName.includes(wanted) ||
      wanted.includes(itemName)
    ) {
      result += 100;
    }

    const wantedWords =
      new Set(wanted.split(" "));

    const itemWords =
      new Set(itemName.split(" "));

    for (const word of wantedWords) {
      if (
        word.length >= 2 &&
        itemWords.has(word)
      ) {
        result += 10;
      }
    }

    const itemYear =
      getItemYear(item);

    if (wantedYear && itemYear) {
      if (itemYear === wantedYear) {
        result += 80;
      } else if (
        Math.abs(itemYear - wantedYear) === 1
      ) {
        result += 10;
      } else {
        result -= 100;
      }
    }

    best = Math.max(best, result);
  }

  return best;
}

/* =========================================================
   TVNETIL FIND
========================================================= */

async function findTVNetilItem(
  type,
  names,
  wantedYear
) {
  let best = null;
  let bestScore = -1;

  for (
    let skip = 0;
    skip <= 10000;
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
      const currentScore =
        score(
          item,
          names,
          wantedYear
        );

      if (currentScore > bestScore) {
        bestScore = currentScore;
        best = item;
      }
    }

    console.log(
      "CATALOG PAGE:",
      skip,
      "BEST:",
      best?.name || best?.title,
      "SCORE:",
      bestScore
    );

    if (bestScore >= 280) {
      break;
    }

    if (metas.length < 100) {
      break;
    }
  }

  console.log(
    "FINAL TVNETIL MATCH:",
    best?.id,
    best?.name || best?.title,
    bestScore
  );

  return bestScore >= 100
    ? {
        item: best,
        score: bestScore
      }
    : null;
}

/* =========================================================
   FAVEZ0NE SEARCH
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

  const html =
    await getText(
      FAVE_SEARCH,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",

          "Referer":
            FAVE_HOME + "/",

          "Origin":
            FAVE_HOME,

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
   FAVEZ0NE INTERNAL LINKS
========================================================= */

function extractFavezInternalLinks(html) {
  const results = [];

  /*
     /move/123
  */

  const moveRegex =
    /href\s*=\s*["'](\/move\/[^"']+)["']/gi;

  let match;

  while (
    (match = moveRegex.exec(html)) !== null
  ) {
    const url =
      new URL(
        decodeHtml(match[1]),
        FAVE_HOME
      ).href;

    results.push(url);
  }

  /*
     /go/123
  */

  const goRegex =
    /(?:href\s*=\s*["'])?(\/go\/[^"'<>\s]+)/gi;

  while (
    (match = goRegex.exec(html)) !== null
  ) {
    const url =
      new URL(
        decodeHtml(match[1]),
        FAVE_HOME
      ).href;

    results.push(url);
  }

  return [...new Set(results)];
}

/* =========================================================
   FAVEZ0NE DIRECT LINKS
========================================================= */

function extractDirectLinks(html) {
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
    (match = directRegex.exec(html)) !== null
  ) {
    let url =
      decodeHtml(match[0])
        .replace(/[\r\n\t]/g, "")
        .replace(/[),.;]+$/, "")
        .trim();

    results.push(url);
  }

  return [
    ...new Set(results)
  ];
}

/* =========================================================
   FAVEZ0NE FOLLOW INTERNAL LINK
========================================================= */

async function followFavezLink(url) {
  console.log(
    "FAVE FOLLOW:",
    url
  );

  try {
    const response =
      await fetch(url, {
        redirect: "manual",

        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",

          "Referer":
            FAVE_HOME + "/"
        }
      });

    const location =
      response.headers.get(
        "location"
      );

    console.log(
      "FAVE STATUS:",
      response.status,
      "LOCATION:",
      location
    );

    if (location) {
      return location;
    }

    const html =
      await response.text();

    /*
       Sometimes the target is inside
       the response body.
    */

    const direct =
      extractDirectLinks(html);

    return direct[0] || null;

  } catch (error) {

    console.error(
      "FAVE FOLLOW ERROR:",
      error.message
    );

    return null;
  }
}

/* =========================================================
   FAVEZ0NE RESOLVE
========================================================= */

async function resolveFavezLinks(html) {

  const internal =
    extractFavezInternalLinks(html);

  const direct =
    extractDirectLinks(html);

  console.log(
    "FAVE INTERNAL LINKS:",
    internal
  );

  console.log(
    "FAVE DIRECT LINKS:",
    direct
  );

  const results = [
    ...direct
  ];

  /*
     Follow /move/ and /go/
  */

  for (const link of internal) {

    const finalUrl =
      await followFavezLink(
        link
      );

    if (finalUrl) {
      results.push(finalUrl);
    }
  }

  return [
    ...new Set(
      results.filter(url =>
        /^https?:\/\//i.test(url)
      )
    )
  ];
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

function cleanStreams(urls) {

  return urls.map(url => {

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

  });
}

/* =========================================================
   FAVE TITLE
========================================================= */

function buildFaveTitle(
  tvTitle,
  tvYear
) {

  let title =
    String(tvTitle || "")
      .trim();

  /*
     TVNetil name is already:
     בלאגן ביער (2025)

     Therefore don't add
     another year.
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
   STREAM
========================================================= */

app.get(
  "/stream/:type/:id.json",
  async (req, res) => {

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

    console.log(
      "================================"
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
         CINEMETA
      --------------------------------- */

      const cinemeta =
        await getJson(
          `${CM}/${type}/${id}.json`
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

      const names = [
        meta.name,
        meta.originalName,
        meta.originalTitle
      ].filter(Boolean);

      console.log(
        "CINEMETA:",
        names,
        wantedYear
      );

      /* ---------------------------------
         TVNETIL
      --------------------------------- */

      const match =
        await findTVNetilItem(
          type,
          names,
          wantedYear
        );

      if (!match?.item?.id) {

        console.log(
          "NO TVNETIL MATCH"
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

      const faveTitle =
        buildFaveTitle(
          tvTitle,
          tvYear
        );

      console.log(
        "TVNETIL:",
        item.id,
        tvTitle,
        tvYear
      );

      console.log(
        "FAVE SEARCH:",
        faveTitle
      );

      /* ---------------------------------
         FAVEZ0NE
      --------------------------------- */

      let html =
        await searchFavez0ne(
          faveTitle
        );

      let urls =
        await resolveFavezLinks(
          html
        );

      let searchUsed =
        faveTitle;

      /* ---------------------------------
         FALLBACK WITHOUT YEAR
      --------------------------------- */

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
          await resolveFavezLinks(
            html
          );

        searchUsed =
          withoutYear;
      }

      const streams =
        cleanStreams(urls);

      console.log(
        "FAVE SEARCH USED:",
        searchUsed
      );

      console.log(
        "FINAL LINKS:",
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

        count:
          results.length,

        results:
          results.map(item => ({
            id:
              item.id,

            name:
              item.name ||
              item.title,

            year:
              getItemYear(item),

            type:
              item.type
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
   TVNETIL LIST
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
        Array.isArray(data?.metas)
          ? data.metas
          : [];

      return res.json({

        success: true,

        type,

        skip,

        count:
          metas.length,

        movies:
          metas.map(item => ({
            id:
              item.id,

            name:
              item.name ||
              item.title,

            year:
              getItemYear(item)
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
          .includes(type) ||
        !/^tt\d+$/.test(id)
      ) {

        return res.status(400).json({
          error:
            "Invalid type or IMDb ID"
        });
      }

      /* CINEMETA */

      const cinemeta =
        await getJson(
          `${CM}/${type}/${id}.json`
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

      const names = [
        meta.name,
        meta.originalName,
        meta.originalTitle
      ].filter(Boolean);

      /* TVNETIL */

      const match =
        await findTVNetilItem(
          type,
          names,
          wantedYear
        );

      if (!match?.item) {

        return res.json({

          success: false,

          step:
            "tvnetil-match",

          cinemeta: {
            id,
            names,
            year:
              wantedYear
          },

          message:
            "No safe TVNetil title match found"

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

      /* FAVE */

      let html =
        await searchFavez0ne(
          faveTitle
        );

      let internal =
        extractFavezInternalLinks(
          html
        );

      let direct =
        extractDirectLinks(
          html
        );

      let urls =
        await resolveFavezLinks(
          html
        );

      let searchUsed =
        faveTitle;

      /* FALLBACK */

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

        internal =
          extractFavezInternalLinks(
            html
          );

        direct =
          extractDirectLinks(
            html
          );

        urls =
          await resolveFavezLinks(
            html
          );

        searchUsed =
          withoutYear;
      }

      return res.json({

        success: true,

        cinemeta: {

          id,

          names,

          year:
            wantedYear,

          tmdb:
            meta.moviedb_id ||
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

          internalLinks:
            internal,

          directLinks:
            direct,

          resolvedLinks:
            urls,

          linkCount:
            urls.length

        },

        streams:
          cleanStreams(urls)

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
      );

    try {

      const html =
        await searchFavez0ne(
          title
        );

      const internal =
        extractFavezInternalLinks(
          html
        );

      const direct =
        extractDirectLinks(
          html
        );

      const resolved =
        await resolveFavezLinks(
          html
        );

      return res.json({

        success: true,

        query:
          title,

        htmlLength:
          html.length,

        internalLinks:
          internal,

        directLinks:
          direct,

        resolvedLinks:
          resolved,

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
