import express from "express";

const app = express();

const TV = "https://tvnetil-addon.vercel.app";
const CM = "https://v3-cinemeta.strem.io/meta";

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "1.3.3",
  name: "TVNetil Direct Streams",
  description: "TVNetil streams for Nuvio/Cinemeta",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"]
};

app.get("/manifest.json", (_, res) => {
  res.json(MANIFEST);
});

async function getJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "TVNetil-Nuvio-Addon/1.3.3",
      "Accept": "application/json"
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  }

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

/*
====================================================
NAME MATCHING
====================================================
*/

function getNames(item) {
  const names = [
    item.name,
    item.title,
    item.originalName,
    item.originalTitle,
    item.enName,
    item.englishName
  ];

  return names
    .filter(Boolean)
    .map(normalize)
    .filter(Boolean);
}

function removeYear(name) {
  return normalize(name)
    .replace(/\b(19|20)\d{2}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function namesMatch(item, wantedNames) {
  const itemNames = getNames(item);

  const wanted = wantedNames
    .filter(Boolean)
    .map(normalize)
    .filter(Boolean);

  for (const itemName of itemNames) {
    const cleanItem = removeYear(itemName);

    for (const wantedName of wanted) {
      const cleanWanted = removeYear(wantedName);

      if (!cleanItem || !cleanWanted) {
        continue;
      }

      /*
      Exact match
      */
      if (cleanItem === cleanWanted) {
        return true;
      }

      /*
      One name contains the other ONLY if
      the shorter name has at least 4 characters.
      */

      if (
        cleanItem.length >= 4 &&
        cleanWanted.length >= 4 &&
        (
          cleanItem.includes(cleanWanted) ||
          cleanWanted.includes(cleanItem)
        )
      ) {
        return true;
      }

      /*
      Compare individual words.
      Require a meaningful amount of overlap.
      */

      const a = new Set(cleanItem.split(" "));
      const b = new Set(cleanWanted.split(" "));

      const common = [...a].filter(
        word =>
          word.length >= 3 &&
          b.has(word)
      );

      if (
        common.length >= 2
      ) {
        return true;
      }
    }
  }

  return false;
}

function score(item, wantedNames, wantedYear) {
  const itemNames = getNames(item);

  if (!itemNames.length) {
    return -1;
  }

  const wanted = wantedNames
    .filter(Boolean)
    .map(normalize)
    .filter(Boolean);

  let bestNameScore = -1;

  for (const itemName of itemNames) {
    const cleanItem = removeYear(itemName);

    for (const wantedName of wanted) {
      const cleanWanted = removeYear(wantedName);

      if (!cleanItem || !cleanWanted) {
        continue;
      }

      let current = 0;

      if (cleanItem === cleanWanted) {
        current = 200;
      } else if (
        cleanItem.length >= 4 &&
        cleanWanted.length >= 4 &&
        (
          cleanItem.includes(cleanWanted) ||
          cleanWanted.includes(cleanItem)
        )
      ) {
        current = 130;
      } else {
        const a = new Set(cleanItem.split(" "));
        const b = new Set(cleanWanted.split(" "));

        const common = [...a].filter(
          word =>
            word.length >= 3 &&
            b.has(word)
        );

        if (common.length >= 2) {
          current = 100 + common.length * 10;
        }
      }

      bestNameScore = Math.max(
        bestNameScore,
        current
      );
    }
  }

  /*
  IMPORTANT:
  Year is only a bonus.
  Year can NEVER create a match by itself.
  */

  if (bestNameScore < 100) {
    return -1;
  }

  const itemYear = getItemYear(item);

  if (wantedYear && itemYear) {
    if (itemYear === wantedYear) {
      bestNameScore += 40;
    } else if (
      Math.abs(itemYear - wantedYear) === 1
    ) {
      bestNameScore += 5;
    } else {
      bestNameScore -= 30;
    }
  }

  return bestNameScore;
}

/*
====================================================
CATALOG
====================================================
*/

async function getCatalog(type, skip) {
  const catalog =
    type === "series"
      ? "tvnetil_series"
      : "tvnetil_movies";

  const url =
    `${TV}/catalog/${type}/${catalog}.json?skip=${skip}`;

  return await getJson(url);
}

/*
====================================================
FIND TVNETIL ITEM
====================================================
*/

async function findTVNetilItem(
  type,
  wantedNames,
  wantedYear
) {
  let best = null;
  let bestScore = -1;

  console.log(
    "SEARCH TVNETIL:",
    wantedNames,
    "YEAR:",
    wantedYear
  );

  for (
    let skip = 0;
    skip <= 10000;
    skip += 100
  ) {
    let data;

    try {
      data = await getCatalog(
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
          wantedNames,
          wantedYear
        );

      if (
        currentScore > bestScore
      ) {
        bestScore = currentScore;
        best = item;
      }
    }

    console.log(
      "CATALOG PAGE:",
      skip,
      "ITEMS:",
      metas.length,
      "BEST:",
      best?.name || best?.title,
      "SCORE:",
      bestScore
    );

    /*
    Exact/very strong match.
    */

    if (bestScore >= 200) {
      break;
    }

    if (metas.length < 100) {
      break;
    }
  }

  console.log(
    "FINAL MATCH:",
    best?.id,
    best?.name || best?.title,
    "SCORE:",
    bestScore
  );

  /*
  VERY IMPORTANT:
  Never return a weak match.
  */

  if (
    !best ||
    bestScore < 100
  ) {
    return null;
  }

  /*
  Final safety check.
  */

  if (
    !namesMatch(
      best,
      wantedNames
    )
  ) {
    console.log(
      "FINAL NAME CHECK FAILED"
    );

    return null;
  }

  return best;
}

/*
====================================================
STREAM CLEANUP
====================================================
*/

function cleanStreams(streams) {
  if (!Array.isArray(streams)) {
    return [];
  }

  return streams
    .filter(
      stream =>
        stream &&
        typeof stream.url === "string" &&
        stream.url.length > 0
    )
    .map((stream, index) => {
      const result = {
        name:
          stream.name ||
          "TVNetil",

        title:
          stream.title ||
          stream.name ||
          `TVNetil ${index + 1}`,

        url: stream.url
      };

      if (stream.behaviorHints) {
        result.behaviorHints =
          stream.behaviorHints;
      }

      if (stream.externalUrl) {
        result.externalUrl =
          stream.externalUrl;
      }

      return result;
    });
}

/*
====================================================
STREAM ENDPOINT
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
      !["movie", "series"].includes(type) ||
      !/^tt\d+$/.test(id)
    ) {
      return res.json({
        streams: []
      });
    }

    try {
      /*
      Get Cinemeta metadata
      */

      const cinemeta =
        await getJson(
          `${CM}/${type}/${id}.json`
        );

      const meta =
        cinemeta?.meta;

      if (!meta?.name) {
        console.error(
          "NO CINEMETA META:",
          id
        );

        return res.json({
          streams: []
        });
      }

      /*
      Build all useful names.
      */

      const wantedNames = [
        meta.name,
        meta.originalName,
        meta.originalTitle,
        meta.englishName
      ].filter(Boolean);

      /*
      Add IMDb ID / TMDB ID only for logging.
      */

      const tmdbId =
        meta.moviedb_id ||
        meta.tmdb_id ||
        meta.tmdbId ||
        null;

      const wantedYear =
        extractYear(
          meta.releaseInfo ||
          meta.releaseDate ||
          meta.year
        );

      console.log(
        "CINEMETA:",
        wantedNames,
        "YEAR:",
        wantedYear,
        "TMDB:",
        tmdbId
      );

      /*
      Find exact TVNetil title match.
      */

      const item =
        await findTVNetilItem(
          type,
          wantedNames,
          wantedYear
        );

      if (!item?.id) {
        console.error(
          "NO SAFE TVNETIL MATCH:",
          wantedNames,
          wantedYear
        );

        return res.json({
          streams: []
        });
      }

      console.log(
        "TVNETIL MATCH:",
        item.id,
        item.name || item.title
      );

      /*
      Get TVNetil streams
      */

      const streamUrl =
        `${TV}/stream/${type}/${encodeURIComponent(
          item.id
        )}.json`;

      console.log(
        "STREAM URL:",
        streamUrl
      );

      const streamData =
        await getJson(
          streamUrl
        );

      const streams =
        cleanStreams(
          streamData?.streams
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
SEARCH DEBUG
====================================================
*/

app.get(
  "/search.json",
  async (req, res) => {
    const q =
      normalize(
        req.query.q || ""
      );

    const type =
      req.query.type === "series"
        ? "series"
        : "movie";

    if (!q) {
      return res.status(400).json({
        error:
          "Missing ?q= parameter"
      });
    }

    const results = [];

    try {
      for (
        let skip = 0;
        skip <= 10000;
        skip += 100
      ) {
        const data =
          await getCatalog(
            type,
            skip
          );

        const metas =
          Array.isArray(data.metas)
            ? data.metas
            : [];

        if (!metas.length) {
          break;
        }

        for (const item of metas) {
          const names =
            getNames(item);

          const matched =
            names.some(name => {
              const clean =
                removeYear(name);

              return (
                clean === q ||
                (
                  clean.length >= 4 &&
                  (
                    clean.includes(q) ||
                    q.includes(clean)
                  )
                )
              );
            });

          if (matched) {
            results.push({
              id: item.id,
              name:
                item.name ||
                item.title,
              year:
                getItemYear(item),
              names
            });
          }
        }

        if (
          results.length >= 20
        ) {
          break;
        }

        if (
          metas.length < 100
        ) {
          break;
        }
      }

      return res.json({
        query: q,
        type,
        results
      });

    } catch (error) {
      return res.status(500).json({
        error:
          error.message
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
          step: "cinemeta",
          success: false,
          data: cinemeta
        });
      }

      const wantedNames = [
        meta.name,
        meta.originalName,
        meta.originalTitle,
        meta.englishName
      ].filter(Boolean);

      const wantedYear =
        extractYear(
          meta.releaseInfo ||
          meta.releaseDate ||
          meta.year
        );

      const tmdbId =
        meta.moviedb_id ||
        meta.tmdb_id ||
        meta.tmdbId ||
        null;

      /*
      TVNetil match
      */

      const item =
        await findTVNetilItem(
          type,
          wantedNames,
          wantedYear
        );

      if (!item?.id) {
        return res.json({
          step:
            "tvnetil-match",
          success: false,

          cinemeta: {
            id,
            names: wantedNames,
            year: wantedYear,
            tmdb: tmdbId
          },

          message:
            "No safe TVNetil title match found"
        });
      }

      /*
      Streams
      */

      const streamUrl =
        `${TV}/stream/${type}/${encodeURIComponent(
          item.id
        )}.json`;

      const streamData =
        await getJson(
          streamUrl
        );

      const streams =
        cleanStreams(
          streamData?.streams
        );

      return res.json({
        success: true,

        cinemeta: {
          id,
          names: wantedNames,
          year: wantedYear,
          tmdb: tmdbId
        },

        match: {
          id: item.id,
          name:
            item.name ||
            item.title,
          year:
            getItemYear(item),
          score:
            score(
              item,
              wantedNames,
              wantedYear
            )
        },

        streamUrl,

        streamCount:
          streams.length,

        streams
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
      "TVNetil Direct Streams v1.3.3 - LIVE"
    );
  }
);

app.listen(
  process.env.PORT || 3000,
  () =>
    console.log(
      "TVNetil Direct Streams v1.3.3 started"
    )
);
