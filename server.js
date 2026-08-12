import express from "express";

const app = express();

const TV = "https://tvnetil-addon.vercel.app";
const FAVE = "https://www.favez0ne.net/search.php";

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "1.6.0",
  name: "TVNetil Direct Streams",
  description: "TVNetil Hebrew titles -> FaveZone",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"]
};

/* =========================
   HTTP
========================= */

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

  return JSON.parse(text);
}

/* =========================
   TEXT
========================= */

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

/* =========================
   TVNETIL CATALOG
========================= */

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

/* =========================
   TVNETIL SEARCH
========================= */

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
      Array.isArray(data.metas)
        ? data.metas
        : [];

    if (!metas.length) {
      break;
    }

    for (const item of metas) {
      const name = normalize(
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
          .filter(x => x.length >= 2);

      const matched =
        wantedWords.filter(word =>
          name.includes(word)
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

/* =========================
   HTML DECODE
========================= */

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

/* =========================
   FAVEZONE SEARCH
========================= */

async function searchFavez0ne(title) {

  const body =
    new URLSearchParams({
      srch: title,
      "submit.x": "0",
      "submit.y": "0"
    }).toString();

  console.log(
    "FAVE SEARCH:",
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

/* =========================
   COUNT FAVE RESULTS
========================= */

function countFaveResults(html) {

  /*
   FaveZone מציג בדף:
   X תוצאות
  */

  const text =
    decodeHtml(html)
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const match =
    text.match(
      /(\d+)\s*(?:תוצאות|תוצאה)/
    );

  if (match) {
    return Number(match[1]);
  }

  /*
   fallback
  */

  if (
    text.includes("0 תוצאות") ||
    text.includes("0 תוצאה")
  ) {
    return 0;
  }

  return null;
}

/* =========================
   EXTRACT LINKS
========================= */

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
  ].filter(url => {

    try {

      const host =
        new URL(url)
          .hostname
          .toLowerCase();

      const allowed = [
        "pixeldrain.com",
        "gofile.io",
        "mega.nz",
        "1fichier.com",
        "send.now",
        "usersdrive.com",
        "usersdrive.net"
      ];

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

/* =========================
   BUILD SEARCH VARIATIONS
========================= */

function buildSearchVariations(title) {

  const original =
    String(title || "")
      .trim();

  const variations = [];

  function add(value) {

    const v =
      String(value || "")
        .trim();

    if (
      v &&
      !variations.includes(v)
    ) {
      variations.push(v);
    }
  }

  add(original);

  /*
   בלי השנה
  */

  add(
    original
      .replace(
        /\s*\(\d{4}\)\s*$/u,
        ""
      )
      .trim()
  );

  /*
   בלי סוגריים
  */

  add(
    original
      .replace(/[()]/g, "")
      .trim()
  );

  /*
   בלי שנה ובלי סוגריים
  */

  add(
    original
      .replace(
        /\s*\(\d{4}\)\s*$/u,
        ""
      )
      .replace(/[()]/g, "")
      .trim()
  );

  return variations;
}

/* =========================
   FAVE SMART SEARCH
========================= */

async function smartFaveSearch(title) {

  const variations =
    buildSearchVariations(title);

  const attempts = [];

  for (const query of variations) {

    try {

      const html =
        await searchFavez0ne(query);

      const count =
        countFaveResults(html);

      const links =
        extractFavezLinks(html);

      attempts.push({
        query,
        htmlLength: html.length,
        resultCount: count,
        linkCount: links.length,
        links
      });

      /*
       אם מצאנו לינקים —
       סיימנו
      */

      if (links.length > 0) {

        return {
          success: true,
          query,
          attempts,
          links,
          html
        };
      }

    } catch (error) {

      attempts.push({
        query,
        error:
          error.message
      });
    }
  }

  return {
    success: false,
    attempts,
    links: []
  };
}

/* =========================
   SEARCH TVNETIL
========================= */

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
            id: item.id,

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

/* =========================
   FAVE DEBUG
========================= */

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
        await smartFaveSearch(
          title
        );

      return res.json({

        success:
          result.success,

        originalQuery:
          title,

        attempts:
          result.attempts,

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

/* =========================
   TVNETIL -> FAVE TEST
========================= */

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
       שלב 1:
       חיפוש TVNetil
      */

      const results =
        await searchTVNetilCatalog(
          type,
          q
        );

      if (!results.length) {

        return res.json({

          success: false,

          step:
            "tvnetil-search",

          query:
            q,

          message:
            "No TVNetil result"

        });
      }

      /*
       לוקחים את התוצאה הראשונה
      */

      const item =
        results[0];

      const tvTitle =
        item.name ||
        item.title ||
        "";

      /*
       שלב 2:
       FaveZone
      */

      const fave =
        await smartFaveSearch(
          tvTitle
        );

      return res.json({

        success:
          fave.success,

        tvnetil: {

          id:
            item.id,

          name:
            tvTitle,

          year:
            getItemYear(item)

        },

        favezone: {

          originalTitle:
            tvTitle,

          attempts:
            fave.attempts,

          links:
            fave.links

        }

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

/* =========================
   STREAM
========================= */

app.get(
  "/stream/:type/:id.json",
  async (req, res) => {

    /*
     כרגע אנחנו משאירים את
     endpoint של התוסף פעיל,
     אבל בלי TMDB/Cinemeta.
     
     בשלב הבא נחבר אותו ישירות
     ל-TVNetil לפי הכותרת.
    */

    return res.json({
      streams: []
    });
  }
);

/* =========================
   MANIFEST
========================= */

app.get(
  "/manifest.json",
  (_, res) => {
    res.json(MANIFEST);
  }
);

/* =========================
   HOME
========================= */

app.get(
  "/",
  (_, res) => {

    res.send(
      "TVNetil Direct Streams v1.6.0 - TEST"
    );
  }
);

/* =========================
   START
========================= */

app.listen(
  process.env.PORT || 3000,
  () => {

    console.log(
      "TVNetil Direct Streams v1.6.0 started"
    );

  }
);
