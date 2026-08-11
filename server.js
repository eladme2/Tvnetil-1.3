import express from "express";

const app = express();

const TV = "https://tvnetil-addon.vercel.app";
const CM = "https://v3-cinemeta.strem.io/meta";
const FAVE = "https://www.favez0ne.net/search.php";

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "1.5.2",
  name: "TVNetil Direct Streams",
  description: "TVNetil titles -> Favez0ne streams for Nuvio/Cinemeta",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"]
};

app.get("/manifest.json", (_, res) => {
  res.json(MANIFEST);
});

/*
====================================================
HTTP
====================================================
*/

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
      `Invalid JSON from ${url}: ${text.slice(0, 300)}`
    );
  }
}

/*
====================================================
TEXT NORMALIZATION
====================================================
*/

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

  return match
    ? Number(match[0])
    : null;
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

/*
====================================================
TVNETIL CATALOG
====================================================
*/

async function getCatalog(type, skip) {
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

/*
====================================================
TVNETIL MATCH
====================================================
*/

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

    /*
    Exact title
    */

    if (itemName === wanted) {
      result += 200;
    }

    /*
    Partial title
    */

    else if (
      itemName.includes(wanted) ||
      wanted.includes(itemName)
    ) {
      result += 100;
    }

    /*
    Word matching
    */

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

    /*
    Year
    */

    const itemYear =
      getItemYear(item);

    if (wantedYear && itemYear) {

      if (itemYear === wantedYear) {
        result += 80;
      }

      else if (
        Math.abs(
          itemYear - wantedYear
        ) === 1
      ) {
        result += 10;
      }

      else {
        result -= 100;
      }
    }

    best =
      Math.max(
        best,
        result
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

  /*
  Search TVNetil catalog
  */

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
      Array.isArray(data.metas)
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

      if (
        currentScore > bestScore
      ) {

        bestScore =
          currentScore;

        best =
          item;
      }
    }

    console.log(
      "CATALOG PAGE:",
      skip,
      "BEST:",
      best?.name ||
      best?.title,
      "SCORE:",
      bestScore
    );

    /*
    Exact enough match
    */

    if (
      bestScore >= 280
    ) {
      break;
    }

    if (
      metas.length < 100
    ) {
      break;
    }
  }

  console.log(
    "FINAL TVNETIL MATCH:",
    best?.id,
    best?.name ||
    best?.title,
    bestScore
  );

  return bestScore >= 100
    ? best
    : null;
}

/*
====================================================
FAVEZ0NE SEARCH
====================================================
*/

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

/*
====================================================
HTML DECODE
====================================================
*/

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

/*
====================================================
EXTRACT FAVEZ0NE LINKS
====================================================
*/

function extractFavezLinks(html) {

  const results = [];

  /*
  Extract href values
  */

  const hrefRegex =
    /href\s*=\s*["']([^"']+)["']/gi;

  let match;

  while (
    (match =
      hrefRegex.exec(html)) !== null
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
  Direct URLs appearing in HTML
  */

  const directRegex =
    /https?:\/\/[^\s"'<>\\]+/gi;

  while (
    (match =
      directRegex.exec(html)) !== null
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

  /*
  Unique
  */

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

/*
====================================================
HOST NAME
====================================================
*/

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

/*
====================================================
STREAMS
====================================================
*/

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

/*
====================================================
CREATE FAVE TITLE
====================================================
*/

function buildFaveTitle(
  tvTitle,
  tvYear
) {

  let title =
    String(
      tvTitle || ""
    ).trim();

  if (
    tvYear &&
    !extractYear(title)
  ) {

    title =
      `${title} (${tvYear})`;
  }

  return title;
}

/*
====================================================
STREAM
====================================================
*/

app.get(
  "/stream/:type/:id.json",
  async (req, res) => {

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
      !["movie", "series"]
        .includes(type) ||
      !/^tt\d+$/.test(id)
    ) {

      return res.json({
        streams: []
      });
    }

    try {

      /*
      CINEMETA
      */

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

      /*
      TVNETIL
      */

      const item =
        await findTVNetilItem(
          type,
          names,
          wantedYear
        );

      if (!item?.id) {

        console.log(
          "NO TVNETIL MATCH"
        );

        return res.json({
          streams: []
        });
      }

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
        "TVNETIL TITLE:",
        tvTitle
      );

      console.log(
        "FAVEZ0NE SEARCH TITLE:",
        faveTitle
      );

      /*
      FAVEZ0NE
      */

      let html =
        await searchFavez0ne(
          faveTitle
        );

      let urls =
        extractFavezLinks(html);

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

        console.log(
          "FAVEZ0NE FALLBACK:",
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
        "FAVEZ0NE SEARCH USED:",
        searchUsed
      );

      console.log(
        "FAVEZ0NE LINKS:",
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

/*
====================================================
FULL DEBUG
====================================================
*/

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

      const item =
        await findTVNetilItem(
          type,
          names,
          wantedYear
        );

      if (!item?.id) {

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

      let html =
        await searchFavez0ne(
          faveTitle
        );

      let urls =
        extractFavezLinks(html);

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
        cleanStreams(urls);

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
            score(
              item,
              names,
              wantedYear
            )
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

      return res.status(500).json({

        success: false,

        error:
          error.stack ||
          error.message
      });
    }
  }
);

/*
====================================================
FAVEZ0NE DEBUG
====================================================
*/

app.get(
  "/fave-debug",
  async (req, res) => {

    const title =
      String(
        req.query.q ||
        "בלאגן ביער (2025)"
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

/*
====================================================
HOME
====================================================
*/

app.get(
  "/",
  (_, res) => {

    res.send(
      "TVNetil Direct Streams v1.5.2 - LIVE"
    );

  }
);

/*
====================================================
START
====================================================
*/

app.listen(
  process.env.PORT || 3000,
  () => {

    console.log(
      "TVNetil Direct Streams v1.5.2 started"
    );

  }
);
