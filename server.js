import express from "express";

const app = express();

const TVNETIL = "https://www.tvnetil.net";
const TVNETIL_API = "https://tvnetil-addon.vercel.app";
const FAVE = "https://www.favez0ne.net/search.php";

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "2.1.0",
  name: "TVNetil Direct Streams",
  description: "Nuvio Hebrew title -> TVNetil page title -> FaveZone",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"]
};

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

  return JSON.parse(text);
}

/* =========================================================
   TEXT
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
      (_, n) => String.fromCharCode(Number(n))
    )
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, n) => String.fromCharCode(parseInt(n, 16))
    );
}

function cleanText(value) {
  return decodeHtml(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractYear(value) {
  const match =
    String(value || "").match(/\b(19|20)\d{2}\b/);

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

  return await getJson(url);
}

async function findCatalogItem(
  type,
  titles
) {
  const wanted =
    titles
      .filter(Boolean)
      .map(normalize);

  for (
    let skip = 0;
    skip < 10000;
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
      const names = [
        item.name,
        item.title,
        item.originalName,
        item.originalTitle
      ]
        .filter(Boolean)
        .map(normalize);

      for (const wantedTitle of wanted) {
        for (const name of names) {
          if (
            name === wantedTitle ||
            name.includes(wantedTitle) ||
            wantedTitle.includes(name)
          ) {
            return item;
          }
        }
      }
    }

    if (metas.length < 100) {
      break;
    }
  }

  return null;
}

/* =========================================================
   TVNETIL SEARCH
========================================================= */

function buildTVNetilSearchUrl(title) {
  return (
    `${TVNETIL}/search/term/?` +
    `search_term=${encodeURIComponent(title)}` +
    `&type=all&go=`
  );
}

/*
   IMPORTANT:
   This is the exact TVNetil search flow.

   We do NOT send the catalog name to FaveZone.
   First we find the actual TVNetil page.
*/

async function searchTVNetil(title) {
  const url =
    buildTVNetilSearchUrl(title);

  console.log(
    "TVNETIL SEARCH:",
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
   FIND REVIEW LINKS
========================================================= */

function extractReviewCandidates(html) {
  const results = [];

  /*
     Standard links:
     <a href="/review/...">TITLE</a>
  */

  const regex =
    /<a\b[^>]*href\s*=\s*["']([^"']*\/review\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while (
    (match = regex.exec(html)) !== null
  ) {
    let url =
      decodeHtml(match[1])
        .replace(/[\r\n\t]/g, "")
        .trim();

    if (
      url.startsWith("/")
    ) {
      url =
        `${TVNETIL}${url}`;
    }

    const text =
      cleanText(match[2]);

    if (
      /^https?:\/\//i.test(url) &&
      text
    ) {
      results.push({
        url,
        text
      });
    }
  }

  return results;
}

/* =========================================================
   FIND BEST TVNETIL PAGE
========================================================= */

function findBestReview(
  candidates,
  requestedTitle
) {
  const wanted =
    normalize(requestedTitle);

  let best = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const text =
      normalize(candidate.text);

    if (!text) {
      continue;
    }

    let score = 0;

    if (
      text === wanted
    ) {
      score = 100;
    } else if (
      text.includes(wanted)
    ) {
      score = 90;
    } else if (
      wanted.includes(text)
    ) {
      score = 80;
    } else {
      const wantedWords =
        wanted
          .split(" ")
          .filter(x => x.length >= 2);

      const pageWords =
        text
          .split(" ")
          .filter(x => x.length >= 2);

      let matched = 0;

      for (const word of wantedWords) {
        if (
          pageWords.includes(word)
        ) {
          matched++;
        }
      }

      if (wantedWords.length) {
        score =
          Math.round(
            matched /
              wantedWords.length *
              70
          );
      }
    }

    if (score > bestScore) {
      bestScore = score;

      best = {
        ...candidate,
        score
      };
    }
  }

  return best;
}

/* =========================================================
   OPEN ACTUAL TVNETIL PAGE
========================================================= */

async function openTVNetilPage(url) {
  console.log(
    "TVNETIL MOVIE PAGE:",
    url
  );

  const html =
    await getText(url);

  return {
    url,
    html,
    title:
      extractPageTitle(html)
  };
}

/* =========================================================
   TITLE FROM ACTUAL TVNETIL PAGE
========================================================= */

function extractPageTitle(html) {

  /*
     1. H1
  */

  let match =
    html.match(
      /<h1\b[^>]*>([\s\S]*?)<\/h1>/i
    );

  if (match) {
    const title =
      cleanText(match[1]);

    if (title) {
      return title;
    }
  }

  /*
     2. H2
  */

  match =
    html.match(
      /<h2\b[^>]*>([\s\S]*?)<\/h2>/i
    );

  if (match) {
    const title =
      cleanText(match[1]);

    if (title) {
      return title;
    }
  }

  /*
     3. og:title
  */

  match =
    html.match(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
    );

  if (match) {
    const title =
      cleanText(match[1]);

    if (title) {
      return title;
    }
  }

  /*
     4. HTML title
  */

  match =
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

    if (title) {
      return title;
    }
  }

  return null;
}

/* =========================================================
   COMPLETE TVNETIL FLOW
========================================================= */

async function getExactTVNetilTitle(
  hebrewTitle,
  type
) {
  /*
     Step 1:
     Search TVNetil using the Hebrew title
     received from Nuvio.
  */

  const search =
    await searchTVNetil(
      hebrewTitle
    );

  /*
     Step 2:
     Extract actual /review/ links
     from the TVNetil search results.
  */

  const candidates =
    extractReviewCandidates(
      search.html
    );

  console.log(
    "TVNETIL SEARCH RESULTS:",
    candidates.length
  );

  if (!candidates.length) {
    return {
      success: false,
      step: "tvnetil-search-results",
      searchUrl: search.url,
      title: null,
      reviewUrl: null
    };
  }

  /*
     Step 3:
     Choose the result matching
     the Hebrew title.
  */

  const best =
    findBestReview(
      candidates,
      hebrewTitle
    );

  if (
    !best ||
    best.score < 55
  ) {
    return {
      success: false,
      step: "tvnetil-match",
      searchUrl: search.url,
      candidates: candidates.slice(0, 20),
      title: null,
      reviewUrl: null
    };
  }

  /*
     Step 4:
     Open the actual TVNetil page.
  */

  const page =
    await openTVNetilPage(
      best.url
    );

  /*
     Step 5:
     Take the title ONLY from
     the actual TVNetil page.
  */

  if (!page.title) {
    return {
      success: false,
      step: "tvnetil-page-title",
      searchUrl: search.url,
      reviewUrl: best.url,
      title: null
    };
  }

  return {
    success: true,
    searchUrl: search.url,
    reviewUrl: best.url,
    title: page.title
  };
}

/* =========================================================
   FAVEZONE SEARCH
========================================================= */

async function searchFavez0ne(
  exactTVNetilTitle
) {
  /*
     IMPORTANT:
     This is the title copied from
     the actual TVNetil movie page.
  */

  console.log(
    "FAVEZONE SEARCH TITLE:",
    exactTVNetilTitle
  );

  const body =
    new URLSearchParams({
      srch:
        exactTVNetilTitle,

      "submit.x":
        "0",

      "submit.y":
        "0"
    }).toString();

  return await getText(
    FAVE,
    {
      method:
        "POST",

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
}

/* =========================================================
   FAVEZONE LINKS
========================================================= */

function extractFavezLinks(html) {
  const links = [];

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

    links.push(url);
  }

  const unique =
    [...new Set(links)];

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
   TEST
========================================================= */

app.get(
  "/test-title",
  async (req, res) => {
    const q =
      String(
        req.query.q || ""
      ).trim();

    const type =
      req.query.type === "series"
        ? "series"
        : "movie";

    if (!q) {
      return res.json({
        success: false,
        message:
          "Use ?q=שם הסרט"
      });
    }

    try {
      /*
         Nuvio title -> TVNetil search
      */

      const tv =
        await getExactTVNetilTitle(
          q,
          type
        );

      if (!tv.success) {
        return res.json({
          success: false,
          step: tv.step,
          inputTitle: q,
          tvnetil: tv
        });
      }

      /*
         TVNetil page title -> FaveZone
      */

      const faveHtml =
        await searchFavez0ne(
          tv.title
        );

      const links =
        extractFavezLinks(
          faveHtml
        );

      return res.json({
        success:
          links.length > 0,

        input: {
          titleFromNuvio:
            q,

          type
        },

        tvnetil: {
          searchUrl:
            tv.searchUrl,

          reviewUrl:
            tv.reviewUrl,

          exactPageTitle:
            tv.title
        },

        favezone: {
          searchTitle:
            tv.title,

          linkCount:
            links.length,

          links
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

    if (!id) {
      return res.json({
        streams: []
      });
    }

    try {

      /*
         =====================================================
         Nuvio / IMDb
         =====================================================
      */

      const metaUrl =
        `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(id)}.json`;

      const meta =
        await getJson(
          metaUrl
        );

      const data =
        meta?.meta || meta;

      /*
         Prefer Hebrew title if Nuvio/Cinemeta
         supplies one.
      */

      const titles = [
        data?.name,
        data?.title,
        data?.originalName,
        data?.originalTitle
      ].filter(Boolean);

      /*
         =====================================================
         IMPORTANT:
         The title is used ONLY to search TVNetil.
         It is NOT sent directly to FaveZone.
         =====================================================
      */

      let tvResult = null;

      for (
        const title
        of titles
      ) {
        try {
          const result =
            await getExactTVNetilTitle(
              title,
              type
            );

          if (
            result.success &&
            result.title
          ) {
            tvResult = result;
            break;
          }
        } catch (error) {
          console.error(
            "TVNETIL ERROR:",
            error.message
          );
        }
      }

      if (
        !tvResult ||
        !tvResult.title
      ) {
        return res.json({
          streams: []
        });
      }

      /*
         =====================================================
         ONLY NOW:
         TVNetil page title -> FaveZone
         =====================================================
      */

      const exactTitle =
        tvResult.title;

      console.log(
        "FINAL TVNETIL PAGE TITLE:",
        exactTitle
      );

      const faveHtml =
        await searchFavez0ne(
          exactTitle
        );

      const links =
        extractFavezLinks(
          faveHtml
        );

      if (!links.length) {
        return res.json({
          streams: []
        });
      }

      return res.json({
        streams:
          links.map(url => ({
            name:
              `TVNetil • ${exactTitle}`,

            title:
              `צפייה ישירה • ${exactTitle}`,

            url,

            type:
              "url",

            behaviorHints: {
              bingeGroup:
                `tvnetil-${type}-${id}`,

              notWebReady:
                false
            }
          }))
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
   SEARCH DEBUG
========================================================= */

app.get(
  "/search-tvnetil",
  async (req, res) => {
    const q =
      String(
        req.query.q || ""
      ).trim();

    const type =
      req.query.type === "series"
        ? "series"
        : "movie";

    if (!q) {
      return res.json({
        success: false,
        message:
          "Use ?q=שם הסרט"
      });
    }

    try {
      const result =
        await getExactTVNetilTitle(
          q,
          type
        );

      return res.json({
        success:
          result.success,

        inputTitle:
          q,

        tvnetil:
          result
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
      "TVNetil Direct Streams v2.1.0"
    );
  }
);

/* =========================================================
   VERCEL
========================================================= */

export default app;
