import OpenAI from "openai";
import { HttpError } from "../lib/http.js";

export default function error(err, req, res, next) {
  if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ message: "That file is larger than 20 MB." });
  if (err instanceof HttpError) {
    if (err.status >= 500) console.error(err.message);
    return res.status(err.status).json({ message: err.message, ...(err.extra || {}) });
  }
  if (err.status && err.status < 500 && err.expose !== false && !(err instanceof OpenAI.APIError)) {
    return res.status(err.status).json({ message: err.message });
  }
  if (err instanceof OpenAI.APIError) {
    // Bad key (401), no access to the model (403/404), quota or rate limit (429), or an outage.
    console.error(`OpenAI error ${err.status}: ${err.message}`);
    const why = err.status === 401 ? "the API key was rejected" : err.status === 429 ? "the usage limit was reached" : err.status === 403 || err.status === 404 ? "the model isn't allowed for this key" : "the AI service is unavailable";
    return res.status(503).json({ message: `AI answers are unavailable right now: ${why}.` });
  }
  console.error(err);
  res.status(500).json({ message: "Something went wrong on our side. Try again." });
}
