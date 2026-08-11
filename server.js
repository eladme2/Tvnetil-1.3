import express from "express";

const app = express();

const TV = "https://tvnetil-addon.vercel.app";
const CM = "https://v3-cinemeta.strem.io/meta";

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "1.3.1",
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
      "User-Agent": "TVNetil-Nuvio-Addon/1.3.1",
      "Accept": "application/json"
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 300)}`);
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

function score(item, wantedName, wantedYear) {
  const itemName = normalize(item.name || item.title);
  const wanted = normalize(wantedName);

  if (!itemName || !wanted) return -1;

  let score = 0;

  if (itemName === wanted) {
    score += 100;
  } else if (
    itemName.includes(wanted) ||
    wanted.includes(itemName)
  ) {
    score += 60;
  }

  const wantedWords = new Set(wanted.split(" "));
  const itemWords = new Set(itemName.split(" "));

  for (const word of wantedWords) {
    if (word.length >= 2 && itemWords.has(word)) {
      score += 8;
    }
  }

  const itemYear = extractYear(
    item.releaseInfo ||
    item.releaseDate ||
    item.year
  );

  if (wantedYear && itemYear) {
    if (itemYear === wantedYear) {
      score += 40;
    } else if (Math.abs(itemYear - wantedYear) === 1) {
      score += 10;
    } else {
      score -= 30;
    }
  }

  return score;
}

async function findTVNetilItem(type, name, wantedYear) {
  const catalog =
    type === "series"
      ? "tvnetil_series"
      : "tvnetil_movies";

  let best = null;
  let bestScore = -1;

  for (let skip = 0; skip <= 5000; skip += 100) {
    const url =
      `${TV}/catalog/${type}/${catalog}.json?skip=${skip}`;

    let data;

    try {
      data = await getJson(url);
    } catch (error) {
      console.error("CATALOG ERROR:", error.message);
      break;
    }

    const metas = Array.isArray(data.metas)
      ? data.metas
      : [];

    if (!metas.length) break;

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

    if (bestScore >= 140 || metas.length < 100) {
      break;
    }
  }

  console.log(
    "MATCH:",
    name,
    "YEAR:",
    wantedYear,
    "RESULT:",
    best?.name || best?.title,
    "SCORE:",
    bestScore
  );

  return bestScore >= 75 ? best : null;
}

function cleanStreams(streams) {
  if (!Array.isArray(streams)) return [];

  return streams
    .filter(stream => stream && stream.url)
    .map((stream, index) => {
      const result = {
        name: stream.name || "TVNetil",
        title:
          stream.title ||
          stream.name ||
          `TVNetil ${index + 1}`,
        url: stream.url
      };

      if (stream.behaviorHints) {
        result.behaviorHints = stream.behaviorHints;
      }

      if (stream.externalUrl) {
        result.externalUrl = stream.externalUrl;
      }

      return result;
    });
}

app.get("/stream/:type/:id.json", async (req, res) => {
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
    // Get metadata from Cinemeta
    const cinemeta = await getJson(
      `${CM}/${type}/${id}.json`
    );

    const meta = cinemeta?.meta;

    if (!meta?.name) {
      console.error("NO CINEMETA META:", id);

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
      wantedYear
    );

    // Find matching item in TVNetil
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
      item.name || item.title
    );

    // Get streams
    const streamUrl =
      `${TV}/stream/${type}/${encodeURIComponent(item.id)}.json`;

    const streamData = await getJson(streamUrl);

    const streams = cleanStreams(
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
      error.stack || error.message
    );

    return res.json({
      streams: []
    });
  }
});

// Debug endpoint
app.get("/debug/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;

  try {
    if (
      !["movie", "series"].includes(type) ||
      !/^tt\d+$/.test(id)
    ) {
      return res.status(400).json({
        error: "Invalid type or IMDb ID"
      });
    }

    const cinemeta = await getJson(
      `${CM}/${type}/${id}.json`
    );

    const meta = cinemeta?.meta;

    if (!meta?.name) {
      return res.json({
        step: "cinemeta",
        success: false,
        data: cinemeta
      });
    }

    const wantedYear = extractYear(
      meta.releaseInfo ||
      meta.releaseDate ||
      meta.year
    );

    const item = await findTVNetilItem(
      type,
      meta.name,
      wantedYear
    );

    if (!item?.id) {
      return res.json({
        step: "tvnetil-match",
        success: false,
        cinemeta: {
          id,
          name: meta.name,
          year: wantedYear
        }
      });
    }

    const streamUrl =
      `${TV}/stream/${type}/${encodeURIComponent(item.id)}.json`;

    const streamData = await getJson(streamUrl);

    return res.json({
      success: true,
      cinemeta: {
        id,
        name: meta.name,
        year: wantedYear
      },
      match: {
        id: item.id,
        name: item.name || item.title
      },
      streamUrl,
      streams: cleanStreams(streamData?.streams)
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/", (_, res) => {
  res.send("TVNetil Direct Streams v1.3.1 - LIVE");
});

app.listen(
  process.env.PORT || 3000,
  () => console.log("TVNetil Direct Streams v1.3.1 started")
);
