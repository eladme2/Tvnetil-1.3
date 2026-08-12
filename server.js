import express from "express";

const app = express();

const TV = "https://tvnetil-addon.vercel.app";
const CM = "https://v3-cinemeta.strem.io/meta";
const FAVE = "https://www.favez0ne.net/search.php";

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "1.6.0",
  name: "TVNetil Direct Streams",
  description: "Hebrew TVNetil -> FaveZone streams for Nuvio",
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

/* =========================================================
   CINEMETA
========================================================= */

async function getCinemeta(type, id) {

  const urls = [
    `${CM}/${type}/${id}.json`,
    `${CM}/${type}/${id}.json?language=he`
  ];

  for (const url of urls) {

    try {

      const data = await getJson(url);

      if (data?.meta) {
        return data.meta;
      }

    } catch (error) {

      console.error(
        "CINEMETA ERROR:",
        error.message
      );

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

      /* exact / partial */

      if (
        name === wanted ||
        name.includes(wanted) ||
        wanted.includes(name)
      ) {

        results.push(item);
        continue;
      }

      /* word matching */

      const wantedWords =
        wanted
          .split(" ")
          .filter(
            x => x.length >= 2
          );

      if (!wantedWords.length) {
        continue;
      }

      const matched =
        wantedWords.filter(
          word =>
            name.includes(word)
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
   FIND TVNETIL MATCH
========================================================= */

function scoreTVNetil(
  item,
  wantedNames,
  wantedYear
) {

  const itemName =
    normalize(
      item.name ||
      item.title
    );

  if (!itemName) {
    return -1;
  }

  let best = -1;

  for (const rawWanted of wantedNames) {

    const wanted =
      normalize(rawWanted);

    if (!wanted) {
      continue;
    }

    let score = 0;

    if (itemName === wanted) {
      score += 300;
    }

    else if (
      itemName.includes(wanted)
    ) {
      score += 200;
    }

    else if (
      wanted.includes(itemName)
    ) {
      score += 150;
    }

    const wantedWords =
      wanted.split(" ")
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
      extractYear(
        item.name ||
        item.title ||
        item.releaseInfo ||
        item.releaseDate ||
        item.description
      );

    if (
      wantedYear &&
      itemYear
    ) {

      if (
        itemYear === wantedYear
      ) {
        score += 100;
      }

      else if (
        Math.abs(
          itemYear - wantedYear
        ) === 1
      ) {
        score += 10;
      }

      else {
        score -= 150;
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

    for (const item of metas) {

      const currentScore =
        scoreTVNetil(
          item,
          names,
          wantedYear
        );

      if (
        currentScore >
        bestScore
      ) {

        bestScore =
          currentScore;

        best =
          item;
      }
    }

    console.log(
      "TVNETIL PAGE:",
      skip,
      "BEST:",
      best?.name,
      "SCORE:",
      bestScore
    );

    if (bestScore >= 300) {
      break;
    }

    if (metas.length < 100) {
      break;
    }
  }

  console.log(
    "FINAL TVNETIL:",
    best?.id,
    best?.name,
    bestScore
  );

  return bestScore >= 100
    ? best
    : null;
}

/* =========================================================
   FAVEZONE
========================================================= */

async function searchFavez0ne(title) {

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
          "https://www.favez0ne.net",

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

function extractFavezLinks(html) {

  const results = [];

  const hrefRegex =
    /href\s*=\s*["']([^"']+)["']/gi;

  let match;

  while (
    (match =
      hrefRegex.exec(html)) !== null
  ) {

    let url =
      decodeHtml(match[1])
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
      host.includes(
        "pixeldrain"
      )
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

    return "FaveZone";
  }
}

/* =========================================================
   STREAMS
========================================================= */

function cleanStreams(urls) {

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
   TVNETIL TITLE
========================================================= */

function buildFaveTitle(
  title
) {

  return String(
    title || ""
  )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

/* =========================================================
   STREAM
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
      ![
        "movie",
        "series"
      ].includes(type)
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

      /* --------------------------------
         1. CINEMETA
      -------------------------------- */

      const meta =
        await getCinemeta(
          type,
          id
        );

      if (!meta) {

        console.log(
          "NO CINEMETA"
        );

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

      /*
       IMPORTANT:
       We use every title Cinemeta
       gives us, including Hebrew
      */

      const names = [
        meta.name,
        meta.originalName,
        meta.originalTitle,
        meta.title
      ]
        .filter(Boolean);

      console.log(
        "CINEMETA NAMES:",
        names
      );

      console.log(
        "YEAR:",
        wantedYear
      );

      /* --------------------------------
         2. TVNETIL SEARCH
      -------------------------------- */

      let item = null;

      /*
       First try names exactly as
       received from Cinemeta.
      */

      item =
        await findTVNetilItem(
          type,
          names,
          wantedYear
        );

      /*
       If the normal match fails,
       use TVNetil's own search endpoint
       for every available title.
      */

      if (!item) {

        console.log(
          "DIRECT MATCH FAILED - TRY SEARCH"
        );

        for (
          const name of names
        ) {

          const searchResults =
            await searchTVNetilCatalog(
              type,
              name
            );

          if (
            searchResults.length
          ) {

            let localBest =
              null;

            let localScore =
              -1;

            for (
              const candidate
              of searchResults
            ) {

              const s =
                scoreTVNetil(
                  candidate,
                  [name],
                  wantedYear
                );

              if (
                s > localScore
              ) {

                localScore = s;
                localBest =
                  candidate;
              }
            }

            if (
              localBest
            ) {

              item =
                localBest;

              console.log(
                "SEARCH MATCH:",
                item.name,
                localScore
              );

              break;
            }
          }
        }
      }

      if (
        !item?.id
      ) {

        console.log(
          "NO TVNETIL MATCH"
        );

        return res.json({
          streams: []
        });
      }

      /*
       THIS IS THE IMPORTANT PART:
       use the title exactly as it exists
       in TVNetil.
      */

      const tvTitle =
        item.name ||
        item.title;

      console.log(
        "TVNETIL HEBREW TITLE:",
        tvTitle
      );

      /* --------------------------------
         3. FAVEZONE
      -------------------------------- */

      const faveTitle =
        buildFaveTitle(
          tvTitle
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
       remove year only.
      */

      if (
        !urls.length
      ) {

        const withoutYear =
          faveTitle
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

      const streams =
        cleanStreams(
          urls
        );

      console.log(
        "FAVEZONE LINKS:",
        urls
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
                extractYear(
                  item.name ||
                  item.title ||
                  item.releaseInfo ||
                  item.releaseDate ||
                  item.description
                ),

              type:
                item.type ||
                type

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
                extractYear(
                  item.name ||
                  item.title ||
                  item.releaseInfo ||
                  item.releaseDate ||
                  item.description
                )

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

        return res.status(400)
          .json({

            success: false,

            error:
              "Invalid type or IMDb ID"

          });
      }

      const meta =
        await getCinemeta(
          type,
          id
        );

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

      const names = [
        meta.name,
        meta.originalName,
        meta.originalTitle,
        meta.title
      ]
        .filter(Boolean);

      const item =
        await findTVNetilItem(
          type,
          names,
          wantedYear
        );

      if (!item) {

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
            "No TVNetil title match found"

        });
      }

      const tvTitle =
        item.name ||
        item.title;

      const faveTitle =
        buildFaveTitle(
          tvTitle
        );

      const html =
        await searchFavez0ne(
          faveTitle
        );

      const links =
        extractFavezLinks(
          html
        );

      return res.json({

        success: true,

        cinemeta: {

          id,

          names,

          year:
            wantedYear

        },

        tvnetil: {

          id:
            item.id,

          name:
            tvTitle,

          score:
            scoreTVNetil(
              item,
              names,
              wantedYear
            )

        },

        favezone: {

          searchTitle:
            faveTitle,

          linkCount:
            links.length,

          links

        },

        streams:
          cleanStreams(
            links
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
