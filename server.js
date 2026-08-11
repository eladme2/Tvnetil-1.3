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
  const response = await fetch(url, {
    headers: {
      "User-Agent": "TVNetil-Nuvio-Addon/1.3.2",
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
    item.description
  );
}

function score(item, wantedName, wantedYear) {
  const itemName = normalize(
    item.name ||
    item.title ||
    item.originalName ||
    item.originalTitle
  );

  const wanted = normalize(wantedName);

  if (!itemName || !wanted) {
    return -1;
  }

  let result = 0;

  // Exact name
  if (itemName === wanted) {
    result += 150;
  }

  // Partial name
  else if (
    itemName.includes(wanted) ||
    wanted.includes(itemName)
  ) {
    result += 90;
  }

  // Individual words
  const wantedWords = new Set(wanted.split(" "));
  const itemWords = new Set(itemName.split(" "));

  for (const word of wantedWords) {
    if (word.length >= 2 && itemWords.has(word)) {
      result += 12;
    }
  }

  // Year
  const itemYear = getItemYear(item);

  if (wantedYear && itemYear) {
    if (itemYear === wantedYear) {
      result += 60;
    } else if (
      Math.abs(itemYear - wantedYear) === 1
    ) {
      result += 15;
    } else {
      result -= 50;
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
  name,
  wantedYear
) {
  let best = null;
  let bestScore = -1;

  console.log(
    "SEARCH TVNETIL:",
    name,
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

    if (bestScore >= 210) {
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

  // Lower threshold so we can test possible matches
  return bestScore >= 60 ? best : null;
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
    const { type, id } = req.params;

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

      const wantedName =
        meta.name;

      const wantedYear =
        extractYear(
          meta.releaseInfo ||
          meta.releaseDate ||
          meta.year
        );

      console.log(
        "CINEMETA:",
        wantedName,
        wantedYear
      );

      /*
      Find TVNetil item
      */

      const item =
        await findTVNetilItem(
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
        await getJson(streamUrl);

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

Example:

/search.json?q=kayara

This searches the TVNetil movie catalog
and returns only matching results.
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
          const name =
            normalize(
              item.name ||
              item.title
            );

          if (
            name.includes(q) ||
            q.includes(name)
          ) {
            results.push({
              id: item.id,
              name:
                item.name ||
                item.title,
              year:
                getItemYear(item)
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
        error: error.message
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

      const wantedYear =
        extractYear(
          meta.releaseInfo ||
          meta.releaseDate ||
          meta.year
        );

      /*
      TVNetil match
      */

      const item =
        await findTVNetilItem(
          type,
          meta.name,
          wantedYear
        );

      if (!item?.id) {
        return res.json({
          step:
            "tvnetil-match",
          success: false,

          cinemeta: {
            id,
            name: meta.name,
            year: wantedYear
          }
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
          name: meta.name,
          year: wantedYear
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
              meta.name,
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
        error: error.message
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
      "TVNetil Direct Streams v1.3.2 - LIVE"
    );
  }
);

app.listen(
  process.env.PORT || 3000,
  () =>
    console.log(
      "TVNetil Direct Streams v1.3.2 started"
    )
);
