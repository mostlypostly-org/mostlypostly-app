// src/utils/moderation.js — MostlyPostly v1.1 (tenant-aware moderation)
import dotenv from "dotenv";
dotenv.config();

import OpenAI from "openai";
import { createLogger } from "../utils/logHelper.js";
import { logEvent, logModeration } from "../core/analyticsDb.js";

// Ensure we have an API key
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const log = createLogger("moderation");

export function sanitizeText(str = "") {
  const banned = [
    "bitch","fuck","shit","asshole","slut","hoe","dick","cock","pussy","whore",
    "bastard","cunt","nude","nsfw","sexy","seductive","sensual","provocative",
    "erotic","fetish","killing","murder","suicide","hate","ass","shit"
  ];
  let out = str;
  for (const w of banned) {
    const re = new RegExp(`\\b${w}\\b`, "gi");
    out = out.replace(re, "⚠️");
  }
  return out;
}

export function isContentSafe(caption = "", hashtags = [], stylistInput = "") {
  const text = `${caption} ${hashtags.join(" ")} ${stylistInput}`.toLowerCase();
  const blocked = [
    "nude","nsfw","erotic","sex","sexual","fetish","provocative",
    "explicit","onlyfans","seductive","pussy","bitch","fuck","murder","suicide",
    "pussy","vagina","pussy","penis","dick"
  ];
  const disallowed = ["racist","sexist","hate","kill","die","violence","weapon"];
  const tokens = text.split(/\b/);
  const bad = blocked.some(w => tokens.includes(w)) || disallowed.some(w => tokens.includes(w));
  if (bad) return false;
  if ((text.match(/🔥|💋|🍑|🍆|💦|🍒|🩱|👙/g) ?? []).length > 2) return false;
  return true;
}

export default async function moderateAIOutput(aiJson, userText = "", meta = {}) {
  const text = `${aiJson.caption || ""} ${userText || ""}`.trim();
  const postId = meta?.post_id || null;
  const salonId = meta?.salon_id || null;

  try {
    // local check
    if (!isContentSafe(aiJson.caption, aiJson.hashtags || [], userText)) {
      const reason = "static-check";
      log("⚠️ Local moderation block:", { text });
      logModeration({ post_id: postId || "preview", salon_id: salonId, level: "block", reasons: [reason] });
      logEvent({ event: "post_flagged_local", salon_id: salonId, post_id: postId, data: { reason, text } });
      return { safe: false, result: { ...aiJson, _meta: { type: "blocked-local", reason } } };
    }

    const response = await openai.moderations.create({
      model: "omni-moderation-latest",
      input: text,
    });

    const result = response.results?.[0];
    const flagged = result?.flagged || false;
    const categories = result?.categories || {};

    if (flagged) {
      const triggered = Object.entries(categories)
        .filter(([_, v]) => v === true)
        .map(([k]) => k);
      log("⚠️ AI moderation flagged:", { triggered });
      logModeration({ post_id: postId || "preview", salon_id: salonId, level: "block", reasons: triggered });
      logEvent({ event: "post_flagged_ai", salon_id: salonId, post_id: postId, data: { categories: triggered } });
      return {
        safe: false,
        result: { ...aiJson, _meta: { type: "blocked-ai", reasons: triggered } },
      };
    }

    logEvent({ event: "post_moderation_passed", salon_id: salonId, post_id: postId, data: { categories } });
    logModeration({ post_id: postId || "preview", salon_id: salonId, level: "info", reasons: ["pass"] });
    return { safe: true, result: { ...aiJson, _meta: { type: "approved" } } };
  } catch (err) {
    console.error("⚠️ [Moderation] Error:", err.message);
    logEvent({ event: "post_moderation_error", salon_id: salonId, post_id: postId, data: { error: err.message } });
    return { safe: true, result: { ...aiJson, _meta: { type: "error-fallback" } } };
  }
}
