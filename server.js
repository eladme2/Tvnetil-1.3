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

  return await getJson(url);
}

/*
====================================================
SEARCH CATALOG BY NAME
====================================================
*/

async function searchCatalogByName(
  type,
  wantedNames,
  wantedYear
) {
  const names = wantedNames
    .map(normalize)
    .filter(Boolean);

  console.log(
    "TVNETIL SEARCH NAMES:",
    names,
    "YEAR:",
    wantedYear
  );

  let candidates = [];

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
      const itemName = normalize(
        item.name ||
        item.title ||
        item.originalName ||
        item.originalTitle
      );

      if (!itemName) {
        continue;
      }

      const itemYear =
        getItemYear(item);

      /*
      Exact name match
      */

      for (const wanted of names) {
        if (itemName === wanted) {
          let score = 200;

          if (
            wantedYear &&
            itemYear === wantedYear
          ) {
            score += 100;
          }

          candidates.push({
            item,
            score
          });
        }
      }

      /*
      Contains match
      */

      for (const wanted of names) {
        if (
          itemName.includes(wanted) ||
          wanted.includes(itemName)
        ) {
          let score = 100;

          if (
            wantedYear &&
            itemYear === wantedYear
          ) {
            score += 80;
          }

          candidates.push({
            item,
            score
          });
        }
      }
    }

    /*
    We can stop after collecting
    enough strong candidates.
    */

    if (
      candidates.some(
        candidate =>
          candidate.score >= 300
      )
    ) {
      break;
    }

    if (metas.length < 100) {
      break;
    }
  }

  candidates.sort(
    (a, b) =>
      b.score - a.score
  );

  /*
  Only accept a safe match.
  */

  const safe =
    candidates.find(
      candidate => {
        const itemYear =
          getItemYear(
            candidate.item
          );

        return (
          candidate.score >= 180 &&
          (
            !wantedYear ||
            !itemYear ||
            itemYear === wantedYear
          )
        );
      }
    );

  if (safe) {
    console.log(
      "SAFE TVNETIL MATCH:",
      safe.item.id,
      safe.item.name ||
        safe.item.title,
      "SCORE:",
      safe.score
    );

    return safe.item;
  }

  console.log(
    "NO SAFE TVNETIL MATCH"
  );

  return null;
}

/*
====================================================
GET TMDB LOCALIZED NAME
====================================================
*/

async function getTMDBNames(
  tmdbId,
  type
) {
  if (!tmdbId) {
    return [];
  }

  /*
  TMDB public API is not used here because
  no API key is required by this endpoint.
  We use Cinemeta's localized metadata first.
  */

  const names = [];

  try {
    const languageUrls = [
      `https://v3-cinemeta.strem.io/meta/${type}/tmdb:${tmdbId}.json`,
      `https://v3-cinemeta.strem.io/meta/${type}/${tmdbId}.json`
    ];

    for (const url of languageUrls) {
      try {
        const data =
          await getJson(url);

        const meta =
          data?.meta;

        if (!meta) {
          continue;
        }

        for (
          const value of [
            meta.name,
            meta.originalName,
            meta.originalTitle,
            meta.title
          ]
        ) {
          if (
            value &&
            !names.includes(value)
          ) {
            names.push(value);
          }
        }
      } catch {
        /*
        Ignore failed alternate
        metadata lookups.
        */
      }
    }
  } catch {
    /*
    Ignore localization failure.
    */
  }

  return names;
}

/*
====================================================
CINEMETA
====================================================
*/

async function getCinemeta(
  type,
  imdbId
) {
  return await getJson(
    `${CM}/${type}/${imdbId}.json`
  );
}

/*
====================================================
CLEAN STREAMS
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
      1. Cinemeta
      */

      const cinemeta =
        await getCinemeta(
          type,
          id
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

      /*
      2. Collect every useful name
      */

      const names = [];

      for (
        const value of [
          meta.name,
          meta.originalName,
          meta.originalTitle,
          meta.title
        ]
      ) {
        if (
          value &&
          !names.includes(value)
        ) {
          names.push(value);
        }
      }

      /*
      3. TMDB ID from Cinemeta
      */

      const tmdbId =
        meta.moviedb_id ||
        meta.tmdb_id ||
        meta.tmdbId;

      /*
      4. Try localized names
      */

      if (tmdbId) {
        const tmdbNames =
          await getTMDBNames(
            tmdbId,
            type
          );

        for (
          const name of tmdbNames
        ) {
          if (
            !names.includes(name)
          ) {
            names.push(name);
          }
        }
      }

      console.log(
        "CINEMETA:",
        meta.name,
        "YEAR:",
        wantedYear,
        "TMDB:",
        tmdbId,
        "NAMES:",
        names
      );

      /*
      5. Find TVNetil item
      */

      const item =
        await searchCatalogByName(
          type,
          names,
          wantedYear
        );

      if (!item?.id) {
        console.error(
          "NO SAFE TVNETIL MATCH:",
          names
        );

        return res.json({
          streams: []
        });
      }

      console.log(
        "TVNETIL MATCH:",
        item.id,
        item.name ||
          item.title
      );

      /*
      6. Get streams
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
DEBUG
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
        await getCinemeta(
          type,
          id
        );

      const meta =
        cinemeta?.meta;

      if (!meta?.name) {
        return res.json({
          success: false,
          step: "cinemeta",
          data: cinemeta
        });
      }

      const wantedYear =
        extractYear(
          meta.releaseInfo ||
          meta.releaseDate ||
          meta.year
        );

      const tmdbId =
        meta.moviedb_id ||
        meta.tmdb_id ||
        meta.tmdbId;

      const names = [];

      for (
        const value of [
          meta.name,
          meta.originalName,
          meta.originalTitle,
          meta.title
        ]
      ) {
        if (
          value &&
          !names.includes(value)
        ) {
          names.push(value);
        }
      }

      const localizedNames =
        await getTMDBNames(
          tmdbId,
          type
        );

      for (
        const name of localizedNames
      ) {
        if (
          !names.includes(name)
        ) {
          names.push(name);
        }
      }

      const item =
        await searchCatalogByName(
          type,
          names,
          wantedYear
        );

      if (!item?.id) {
        return res.json({
          step:
            "tvnetil-match",
          success: false,

          cinemeta: {
            id,
            names,
            year: wantedYear,
            tmdb: tmdbId
          },

          message:
            "No safe TVNetil title match found"
        });
      }

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
          names,
          year: wantedYear,
          tmdb: tmdbId
        },

        match: {
          id: item.id,
          name:
            item.name ||
            item.title,
          year:
            getItemYear(item)
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
          error.stack ||
          error.message
      });
    }
  }
);

/*
====================================================
SEARCH
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

        for (
          const item of metas
        ) {
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
