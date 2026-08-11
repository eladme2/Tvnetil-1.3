import express from "express";

const app = express();

const TV = "https://tvnetil-addon.vercel.app";
const CM = "https://v3-cinemeta.strem.io/meta";

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "1.4.0",
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
      "User-Agent": "TVNetil-Nuvio-Addon/1.4.0",
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
    item.name ||
    item.title ||
    item.description
  );
}

function getItemNames(item) {
  return [
    item.name,
    item.title,
    item.originalName,
    item.originalTitle
  ]
    .filter(Boolean)
    .map(normalize);
}

function scoreName(item, wantedNames) {
  const itemNames = getItemNames(item);

  if (!itemNames.length) {
    return 0;
  }

  let best = 0;

  for (const itemName of itemNames) {
    for (const wantedRaw of wantedNames) {
      const wanted = normalize(wantedRaw);

      if (!wanted || !itemName) {
        continue;
      }

      // Exact
      if (itemName === wanted) {
        best = Math.max(best, 180);
        continue;
      }

      // Remove year from names for comparison
      const itemWithoutYear = itemName
        .replace(/\b(19|20)\d{2}\b/g, "")
        .replace(/\s+/g, " ")
        .trim();

      const wantedWithoutYear = wanted
        .replace(/\b(19|20)\d{2}\b/g, "")
        .replace(/\s+/g, " ")
        .trim();

      if (
        itemWithoutYear &&
        wantedWithoutYear &&
        itemWithoutYear === wantedWithoutYear
      ) {
        best = Math.max(best, 170);
        continue;
      }

      // Partial
      if (
        itemName.includes(wanted) ||
        wanted.includes(itemName)
      ) {
        best = Math.max(best, 120);
        continue;
      }

      // Word matching
      const wantedWords =
        new Set(wantedWithoutYear.split(" "));

      const itemWords =
        new Set(itemWithoutYear.split(" "));

      let matchedWords = 0;

      for (const word of wantedWords) {
        if (
          word.length >= 2 &&
          itemWords.has(word)
        ) {
          matchedWords++;
        }
      }

      if (matchedWords > 0) {
        best = Math.max(
          best,
          matchedWords * 20
        );
      }
    }
  }

  return best;
}

function scoreItem(item, wantedNames, wantedYear) {
  let result =
    scoreName(item, wantedNames);

  const itemYear =
    getItemYear(item);

  if (wantedYear && itemYear) {
    if (itemYear === wantedYear) {
      result += 80;
    } else if (
      Math.abs(itemYear - wantedYear) === 1
    ) {
      result += 20;
    } else {
      result -= 70;
    }
  }

  // Extra search in description
  const description =
    normalize(item.description);

  for (const wantedRaw of wantedNames) {
    const wanted =
      normalize(wantedRaw);

    if (
      wanted &&
      description.includes(wanted)
    ) {
      result += 10;
    }
  }

  return result;
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

  /*
   * Search the complete catalog.
   *
   * We intentionally continue through all available
   * pages instead of stopping after finding a weak match.
   */

  for (
    let skip = 0;
    skip <= 30000;
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
        scoreItem(
          item,
          wantedNames,
          wantedYear
        );

      if (
        currentScore > bestScore
      ) {
        bestScore =
          currentScore;

        best = item;

        console.log(
          "NEW BEST:",
          item.id,
          item.name || item.title,
          "YEAR:",
          getItemYear(item),
          "SCORE:",
          bestScore
        );
      }
    }

    console.log(
      "CATALOG PAGE:",
      skip,
      "ITEMS:",
      metas.length,
      "BEST:",
      best?.name ||
        best?.title,
      "SCORE:",
      bestScore
    );

    /*
     * A very strong exact match with matching year.
     */
    if (
      bestScore >= 260 &&
      getItemYear(best) === wantedYear
    ) {
      break;
    }

    /*
     * TVNetil normally returns 100 items per page.
     * If fewer are returned, this is the final page.
     */
    if (
      metas.length < 100
    ) {
      break;
    }
  }

  console.log(
    "FINAL MATCH:",
    best?.id,
    best?.name ||
      best?.title,
    "YEAR:",
    getItemYear(best),
    "SCORE:",
    bestScore
  );

  /*
   * Require a reasonable match.
   */
  if (
    !best ||
    bestScore < 80
  ) {
    return null;
  }

  return {
    item: best,
    score: bestScore
  };
}

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
    .map(
      (stream, index) => {
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

        if (
          stream.behaviorHints
        ) {
          result.behaviorHints =
            stream.behaviorHints;
        }

        if (
          stream.externalUrl
        ) {
          result.externalUrl =
            stream.externalUrl;
        }

        return result;
      }
    );
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
       * Get Cinemeta metadata.
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

      const wantedYear =
        extractYear(
          meta.releaseInfo ||
          meta.releaseDate ||
          meta.year
        );

      /*
       * Build all useful names.
       */

      const wantedNames = [
        meta.name,
        meta.originalName,
        meta.originalTitle,
        meta.title
      ].filter(Boolean);

      console.log(
        "CINEMETA:",
        wantedNames,
        "YEAR:",
        wantedYear,
        "TMDB:",
        meta.moviedb_id
      );

      /*
       * Find TVNetil item.
       */

      const match =
        await findTVNetilItem(
          type,
          wantedNames,
          wantedYear
        );

      if (!match?.item?.id) {
        console.error(
          "NO TVNETIL MATCH:",
          wantedNames
        );

        return res.json({
          streams: []
        });
      }

      const item =
        match.item;

      console.log(
        "TVNETIL MATCH:",
        item.id,
        item.name ||
          item.title,
        "SCORE:",
        match.score
      );

      /*
       * Get TVNetil streams.
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
        skip <= 30000;
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
            getItemNames(item);

          const description =
            normalize(
              item.description
            );

          const found =
            names.some(
              name =>
                name.includes(q) ||
                q.includes(name)
            ) ||
            description.includes(q);

          if (found) {
            results.push({
              id: item.id,
              name:
                item.name ||
                item.title,
              year:
                getItemYear(item),
              score:
                scoreItem(
                  item,
                  [q],
                  extractYear(q)
                )
            });
          }
        }

        if (
          results.length >= 50
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
       * Cinemeta
       */

      const cinemeta =
        await getJson(
          `${CM}/${type}/${id}.json`
        );

      const meta =
        cinemeta?.meta;

      if (!meta?.name) {
        return res.json({
          step:
            "cinemeta",
          success: false,
          data:
            cinemeta
        });
      }

      const wantedYear =
        extractYear(
          meta.releaseInfo ||
          meta.releaseDate ||
          meta.year
        );

      const wantedNames = [
        meta.name,
        meta.originalName,
        meta.originalTitle,
        meta.title
      ].filter(Boolean);

      /*
       * TVNetil match
       */

      const match =
        await findTVNetilItem(
          type,
          wantedNames,
          wantedYear
        );

      if (!match?.item?.id) {
        return res.json({
          step:
            "tvnetil-match",
          success: false,

          cinemeta: {
            id,
            names:
              wantedNames,
            year:
              wantedYear,
            tmdb:
              meta.moviedb_id
          },

          message:
            "No suitable TVNetil catalog match found"
        });
      }

      const item =
        match.item;

      /*
       * Streams
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
          names:
            wantedNames,
          year:
            wantedYear,
          tmdb:
            meta.moviedb_id
        },

        match: {
          id:
            item.id,

          name:
            item.name ||
            item.title,

          year:
            getItemYear(item),

          score:
            match.score
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
      "TVNetil Direct Streams v1.4.0 - LIVE"
    );
  }
);

app.listen(
  process.env.PORT || 3000,
  () =>
    console.log(
      "TVNetil Direct Streams v1.4.0 started"
    )
);
