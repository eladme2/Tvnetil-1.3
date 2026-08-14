import express from "express";

const app = express();

const SERPER_API_KEY = process.env.SERPER_API_KEY;

const MANIFEST = {
  id: "com.elad.tvnetil.directstreams",
  version: "4.1.3",
  name: "TVNetil Direct Streams",
  description: "Simple search flow for free Serper accounts",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"]
};

/* =========================================================
   HTTP & SERPER (הפשטה של השאילתות)
========================================================= */

async function serperSearch(query) {
  // חיפוש פשוט מאוד ללא תוספות שעלולות לעורר חסימה
  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": SERPER_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      q: query,
      gl: "il",
      hl: "he",
      num: 10
    })
  });
  return await response.json();
}

/* =========================================================
   הלוגיקה המעודכנת (חיפוש פשוט וממוקד סינון)
========================================================= */

async function resolveTVNetil(hebrewTitle) {
  // שלב 1: חיפוש שם הסרט בלבד
  const search1 = await serperSearch(hebrewTitle);
  const results1 = search1.organic || [];
  
  // סינון ידני ל-TVNetil
  const tvnetilResult = results1.find(r => r.link.includes("tvnetil.net/review/"));
  if (!tvnetilResult) return { success: false, step: "no_tvnetil_found" };

  // חילוץ שם ושנה מהכותרת שנמצאה
  const exactTitle = tvnetilResult.title.replace(/מדובב|מתורגם|TVNetil/gi, "").trim();

  // שלב 2: חיפוש הסרט עם השם המדויק (ללא מילת מפתח נוספת אם לא חייב)
  const search2 = await serperSearch(exactTitle);
  const results2 = search2.organic || [];

  // חילוץ קישורים מתוך התוצאות של פאבה
  const streams = results2
    .filter(r => r.link.includes("favez0ne") && (r.link.includes("pixeldrain") || r.link.includes("gofile")))
    .map(r => ({
      name: r.link.includes("pixeldrain") ? "PixelDrain" : "GoFile",
      url: r.link,
      type: "http"
    }));

  return { success: streams.length > 0, streams };
}

// ... שאר הפונקציות (getMetadata, getHebrewTitle וכו') נשארות זהות ...

/* =========================================================
   TEST & ENDPOINTS
========================================================= */

app.get("/test-title", async (req, res) => {
  try {
    return res.json(await resolveTVNetil(req.query.q));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.listen(process.env.PORT || 3000);

export default app;
