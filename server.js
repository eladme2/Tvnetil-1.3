import express from "express";

const app = express();

const TV = "https://tvnetil-addon.vercel.app";
const CM = "https://v3-cinemeta.strem.io/meta";
const FAVE = "https://www.favez0ne.net/search.php";

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "1.4.2",
  name: "TVNetil Direct Streams",
  description: "TVNetil titles -> Favez0ne streams for Nuvio/Cinemeta",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"]
};

app.get("/manifest.json", (_, res) => {
  res.json(MANIFEST);
});

async function getText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
      "Accept":
        "text/html,application/xhtml+xml,application/json,*/*",
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

async function getCatalog(type, skip) {
  const catalog =
    type === "series"
      ? "tvnetil_series"
      : "tvnetil_movies";

  const url =
    `${TV}/catalog/${type}/${catalog}.json?skip=${skip}`;

  return await getJson(url);
}

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

    const itemYear = getItemYear(item);

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
    ? best
    : null;
}

/*
====================================================
WINDOWS-1255 ENCODER
Favez0ne uses charset=windows-1255.
Hebrew letters are encoded as E0-FA.
====================================================
*/

function encodeWindows1255(value) {
  const bytes = [];

  for (const char of String(value || "")) {
    const code = char.charCodeAt(0);

    /*
    Hebrew:
    א = E0
    ב = E1
    ...
    ת = FA
    */

    if (
      code >= 0x05D0 &&
      code <= 0x05EA
    ) {
      bytes.push(
        0xE0 + (code - 0x05D0)
      );
      continue;
    }

    /*
    ASCII
    */

    if (code <= 0x7F) {
      bytes.push(code);
      continue;
    }

    /*
    Common punctuation
    */

    const special = {
      0x00A0: 0xA0,
      0x00A9: 0xA9,
      0x00AE: 0xAE,
      0x2013: 0x96,
      0x2014: 0x97,
      0x2018: 0x91,
      0x2019: 0x92,
      0x201C: 0x93,
      0x201D: 0x94,
      0x20AC: 0x80
    };

    if (
      Object.prototype.hasOwnProperty.call(
        special,
        code
      )
    ) {
      bytes.push(special[code]);
    } else {
      bytes.push(0x3F);
    }
  }

  return Buffer.from(bytes);
}

/*
====================================================
URL FORM ENCODER
====================================================
*/

function encodeForm1255(value) {
  const bytes =
    encodeWindows1255(value);

  let result = "";

  for (const byte of bytes) {
    /*
    application/x-www-form-urlencoded

    A-Z
    a-z
    0-9
    - _ . ~
    stay unescaped.

    Space becomes +
    */

    if (
      byte === 0x20
    ) {
      result += "+";
    } else if (
      (byte >= 0x41 && byte <= 0x5A) ||
      (byte >= 0x61 && byte <= 0x7A) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2D ||
      byte === 0x5F ||
      byte === 0x2E ||
      byte === 0x7E
    ) {
      result += String.fromCharCode(byte);
    } else {
      result +=
        "%" +
        byte
          .toString(16)
          .toUpperCase()
          .padStart(2, "0");
    }
  }

  return result;
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

  const cleanTitle =
    String(title || "")
      .replace(/\s+/g, " ")
      .trim();

  /*
  IMPORTANT:
  Do NOT use URLSearchParams here.
  Favez0ne expects Windows-1255.
  */

  const body =
    "srch=" +
    encodeForm1255(cleanTitle) +
    "&submit.x=0&submit.y=0";

  console.log(
    "FAVEZ0NE BODY:",
    body
  );

  const html =
    await getText(
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
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCharCode(Number(n))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCharCode(
        parseInt(n, 16)
      )
    );
}

/*
====================================================
EXTRACT LINKS
====================================================
*/

function extractFavezLinks(html) {
  const results = [];

  /*
  Direct href links
  */

  const hrefRegex =
    /href\s*=\s*["']([^"']+)["']/gi;

  let match;

  while (
    (match = hrefRegex.exec(html)) !== null
  ) {
    let url =
      decodeHtml(match[1]).trim();

    if (
      /^https?:\/\//i.test(url)
    ) {
      results.push(url);
    }
  }

  /*
  Direct URLs inside HTML / JavaScript
  */

  const directRegex =
    /https?:\/\/[^\s"'<>\\]+/gi;

  while (
    (match = directRegex.exec(html)) !== null
  ) {
    let url =
      decodeHtml(match[0])
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
          host.endsWith("." + domain)
      );
    } catch {
      return false;
    }
  });
}

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
    return "Favez0ne";
  }
}

function cleanStreams(urls) {
  return urls.map(url => ({
    name: hostName(url),

    title:
      `${hostName(url)} | Favez0ne`,

    url,

    behaviorHints: {
      notWebReady: true
    }
  }));
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
      Cinemeta
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

      /*
      TVNetil
      */

      const item =
        await findTVNetilItem(
          type,
          names,
          wantedYear
        );

      if (!item?.id) {
        return res.json({
          streams: []
        });
      }

      const tvTitle =
        item.name ||
        item.title;

      const tvYear =
        getItemYear(item);

      let faveTitle =
        tvTitle;

      if (
        tvYear &&
        !extractYear(faveTitle)
      ) {
        faveTitle =
          `${faveTitle} (${tvYear})`;
      }

      console.log(
        "FAVEZ0NE TITLE:",
        faveTitle
      );

      /*
      Favez0ne
      */

      const html =
        await searchFavez0ne(
          faveTitle
        );

      const urls =
        extractFavezLinks(html);

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
          step: "tvnetil-match",
          cinemeta: {
            id,
            names,
            year: wantedYear
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

      let faveTitle =
        tvTitle;

      if (
        tvYear &&
        !extractYear(faveTitle)
      ) {
        faveTitle =
          `${faveTitle} (${tvYear})`;
      }

      const html =
        await searchFavez0ne(
          faveTitle
        );

      const urls =
        extractFavezLinks(html);

      const streams =
        cleanStreams(urls);

      return res.json({
        success: true,

        cinemeta: {
          id,
          names,
          year: wantedYear,
          tmdb:
            meta.moviedb_id || null
        },

        tvnetil: {
          id: item.id,
          name: tvTitle,
          year: tvYear,

          score:
            score(
              item,
              names,
              wantedYear
            )
        },

        favezone: {
          searchTitle: faveTitle,
          linkCount: urls.length,
          links: urls
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
        extractFavezLinks(html);

      return res.json({

        success: true,

        query: title,

        htmlLength:
          html.length,

        links,

        html

      });

    } catch (error) {

      return res.status(500).json({
        success: false,
        error:
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
      "TVNetil Direct Streams v1.4.2 - LIVE"
    );
  }
);

app.listen(
  process.env.PORT || 3000,
  () =>
    console.log(
      "TVNetil Direct Streams v1.4.2 started"
    )
);
