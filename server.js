import express from "express";

const app = express();

const TV = "https://tvnetil-addon.vercel.app";
const CM = "https://v3-cinemeta.strem.io/meta";

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "1.3.2",
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
  console.log("GET:", url);

  const response = await fetch(url, {
    headers: {
      "User-Agent": "TVNetil-Nuvio-Addon/1.3.2",
      "Accept": "application/json"
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${text.slice(0, 500)}`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Invalid JSON from ${url}: ${text.slice(0, 500)}`
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
  const match = String(value || "").match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function getItemName(item) {
  return (
    item.name ||
    item.title ||
    item.meta?.name ||
    item.meta?.title ||
    ""
  );
}

function getItemYear(item) {
  return extractYear(
    item.releaseInfo ||
    item.releaseDate ||
    item.year ||
    item.meta?.releaseInfo ||
    item.meta?.releaseDate ||
    item.meta?.year
  );
}

function score(item, wantedName, wantedYear) {
  const itemName = normalize(getItemName(item));
  const wanted = normalize(wantedName);

  if (!itemName || !wanted) return -1;

  let points = 0;

  if (itemName === wanted) {
    points += 100;
  } else if (
    itemName.includes(wanted) ||
    wanted.includes(itemName)
  ) {
    points += 60;
  }

  const wantedWords = new Set(wanted.split(" "));
  const itemWords = new Set(itemName.split(" "));

  for (const word of wantedWords) {
    if (word.length >= 2 && itemWords.has(word)) {
      points += 8;
    }
  }

  const itemYear = getItemYear(item);

  if (wantedYear && itemYear) {
    if (itemYear === wantedYear) {
      points += 40;
    } else if (Math.abs(itemYear - wantedYear) === 1) {
      points += 10;
    } else {
      points -= 30;
    }
  }

  return points;
}

/*
 * TVNetil manifest:
 *
 * tvnetil_series  -> type movie
 * tvnetil_movies  -> type movie
 * tvnetil_others  -> type movie
 *
 * Therefore BOTH movie and series catalogs are requested
 * using /catalog/movie/...
 */

async function getCatalog(catalogId, skip = 0) {
  const url =
    `${TV}/catalog/movie/${catalogId}.json?skip=${skip}`;

  return await getJson(url);
}

async function findTVNetilItem(type, name, wantedYear) {
  const catalogs =
    type === "series"
      ? ["tvnetil_series"]
      : ["tvnetil_movies"];

  let best = null;
  let bestScore = -1;

  for (const catalog of catalogs) {
    for (let skip = 0; skip <= 5000; skip += 100) {
      let data;

      try {
        data = await getCatalog(catalog, skip);
      } catch (error) {
        console.error(
          "CATALOG ERROR:",
          catalog,
          skip,
          error.message
        );
        break;
      }

      const metas = Array.isArray(data?.metas)
        ? data.metas
        : [];

      console.log(
        "CATALOG:",
        catalog,
        "SKIP:",
        skip,
        "COUNT:",
        metas.length
      );

      if (!metas.length) {
        break;
      }

      for (const item of metas) {
        const currentScore = score(
          item,
          name,
          wantedYear
        );

        if (currentScore > bestScore) {
          bestScore = currentScore;
          best = item;
        }
      }

      if (bestScore >= 140) {
        break;
      }

      if (metas.length < 100) {
        break;
      }
    }
  }

  console.log(
    "BEST MATCH:",
    name,
    "YEAR:",
    wantedYear,
    "RESULT:",
    best ? getItemName(best) : null,
    "ID:",
    best?.id,
    "SCORE:",
    bestScore
  );

  return bestScore >= 60 ? best : null;
}

function cleanStreams(streams) {
  if (!Array.isArray(streams)) {
    return [];
  }

  return streams
    .filter(stream => {
      return (
        stream &&
        (
          stream.url ||
          stream.externalUrl
        )
      );
    })
    .map((stream, index) => {
      const result = {
        name: stream.name || "TVNetil",
        title:
          stream.title ||
          stream.name ||
          `TVNetil ${index + 1}`
      };

      if (stream.url) {
        result.url = stream.url;
      }

      if (stream.behaviorHints) {
        result.behaviorHints = stream.behaviorHints;
      }

      if (stream.externalUrl) {
        result.externalUrl = stream.externalUrl;
      }

      return result;
    });
}

/*
 * TVNetil uses IDs beginning with tvnetil_.
 *
 * The stream endpoint is still requested with the
 * item's real TVNetil ID.
 */

async function getTVNetilStreams(type, item) {
  if (!item?.id) {
    return [];
  }

  const tvnetilId = item.id;

  /*
   * TVNetil exposes movie-type stream endpoints.
   * Even when the source comes from tvnetil_series,
   * its manifest declares the resource type as movie.
   */

  const urls = [
    `${TV}/stream/movie/${encodeURIComponent(tvnetilId)}.json`,
    `${TV}/stream/series/${encodeURIComponent(tvnetilId)}.json`
  ];

  for (const url of urls) {
    try {
      const data = await getJson(url);

      const streams = cleanStreams(data?.streams);

      console.log(
        "STREAM TEST:",
        url,
        "COUNT:",
        streams.length
      );

      if (streams.length) {
        return streams;
      }
    } catch (error) {
      console.error(
        "STREAM ERROR:",
        url,
        error.message
      );
    }
  }

  return [];
}

app.get("/stream/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;

  console.log(
    "===================================="
  );

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
     * STEP 1
     * Get IMDb metadata from Cinemeta.
     */

    const cinemeta = await getJson(
      `${CM}/${type}/${id}.json`
    );

    const meta = cinemeta?.meta;

    if (!meta?.name) {
      console.error(
        "NO CINEMETA META:",
        id
      );

      return res.json({
        streams: []
      });
    }

    const wantedName = meta.name;

    const wantedYear = extractYear(
      meta.releaseInfo ||
      meta.releaseDate ||
      meta.year
    );

    console.log(
      "CINEMETA:",
      wantedName,
      "YEAR:",
      wantedYear
    );

    /*
     * STEP 2
     * Find the same title inside TVNetil.
     */

    const item = await findTVNetilItem(
      type,
      wantedName,
      wantedYear
    );

    if (!item?.id) {
      console.error(
        "NO TVNETIL MATCH:",
        wantedName
      );

      return res.json({
        streams: []
      });
    }

    console.log(
      "TVNETIL MATCH:",
      item.id,
      getItemName(item)
    );

    /*
     * STEP 3
     * Get actual streams.
     */

    const streams = await getTVNetilStreams(
      type,
      item
    );

    console.log(
      "FINAL STREAM COUNT:",
      streams.length
    );

    console.log(
      "===================================="
    );

    return res.json({
      streams
    });

  } catch (error) {
    console.error(
      "FATAL STREAM ERROR:",
      error.stack || error.message
    );

    return res.json({
      streams: []
    });
  }
});

/*
 * DEBUG
 *
 * Example:
 * /debug/movie/tt1234567.json
 */

app.get("/debug/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;

  try {
    if (
      !["movie", "series"].includes(type) ||
      !/^tt\d+$/.test(id)
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid type or IMDb ID"
      });
    }

    /*
     * Cinemeta
     */

    const cinemeta = await getJson(
      `${CM}/${type}/${id}.json`
    );

    const meta = cinemeta?.meta;

    if (!meta?.name) {
      return res.json({
        success: false,
        step: "cinemeta",
        id,
        data: cinemeta
      });
    }

    const wantedYear = extractYear(
      meta.releaseInfo ||
      meta.releaseDate ||
      meta.year
    );

    /*
     * TVNetil match
     */

    const item = await findTVNetilItem(
      type,
      meta.name,
      wantedYear
    );

    if (!item?.id) {
      return res.json({
        success: false,
        step: "tvnetil-match",
        cinemeta: {
          id,
          name: meta.name,
          year: wantedYear
        }
      });
    }

    /*
     * Streams
     */

    const streams = await getTVNetilStreams(
      type,
      item
    );

    return res.json({
      success: streams.length > 0,
      step: "complete",

      cinemeta: {
        id,
        name: meta.name,
        year: wantedYear
      },

      match: {
        id: item.id,
        name: getItemName(item),
        year: getItemYear(item)
      },

      streams
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
});

app.get("/", (_, res) => {
  res.send(
    "TVNetil Direct Streams v1.3.2 - LIVE"
  );
});

app.listen(
  process.env.PORT || 3000,
  () => {
    console.log(
      "TVNetil Direct Streams v1.3.2 started"
    );
  }
);
