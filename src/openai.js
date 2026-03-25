// ============================================================================
//  MostlyPostly - OpenAI Module (Caption Generation + Shadow Classification)
// ============================================================================

import { logEvent } from "./core/analyticsDb.js";

// Helper to remove code fences, markup, etc.
function sanitizeText(str = "") {
  return str
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .replace(/<pre>|<\/pre>/gi, "")
    .replace(/<code>|<\/code>/gi, "")
    .trim();
}

// Safe JSON parse
function tryParseJSON(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// Fallback object for any failure
function fallbackCaption() {
  return {
    service_type: "other",
    caption: "A beautiful new look, ready to turn heads!",
    hashtags: ["#MostlyPostly"],
    cta: "Book your next visit today!",
    _classification: {
      content_type: "standard_post",
      confidence: null,
    },
  };
}

// ============================================================================
//  PRIMARY EXPORT: generateCaption()
// ============================================================================

export async function generateCaption({
  imageDataUrl = null,
  notes = "",
  salon = {},
  stylist = {},
  city = "",
  postType = "standard_post",
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("❌ Missing OPENAI_API_KEY");
    return fallbackCaption();
  }

  const model = "gpt-4o-mini";

  const stylistName =
    stylist?.stylist_name ||
    stylist?.name ||
    stylist?.full_name ||
    "a stylist";

  const instagramHandle = stylist?.instagram_handle || null;

  const salonName =
    salon?.salon_name ||
    salon?.salon_info?.salon_name ||
    "the salon";

  const salonId = salon?.salon_id || salon?.id || null;

  // ===========================
  // SYSTEM PROMPT
  // ===========================
  const toneInstruction = salon?.tone
  ? `Write the caption in a ${salon.tone} tone.
Use word choice, energy, and phrasing that clearly reflects this style.`
  : "";

  const postTypeInstruction = postType === "before_after"
    ? `This is a Before & After transformation post. The caption MUST reference the transformation — use words like "transformation", "before & after", "glow up", or similar. Celebrate the change.`
    : "";

  console.log("🧠 [OpenAI] Tone applied:", salon?.tone || "default");

  const systemPrompt = `
You are MostlyPostly, an AI assistant that writes social media captions for salons.

${toneInstruction}
${postTypeInstruction}

Your reply MUST be a single JSON object. No comments. No code fences.

## PART 1 — Generate a caption:
- Keep it concise: 2–3 sentences max
- DO NOT mention stylist names or Instagram handles
- DO NOT include any “Styled by” lines
- DO NOT include booking links or URLs of any kind
- Caption should be about the hair, the look, the vibe, or the service only
- Hashtags returned as an array — generate exactly 2 relevant hashtags (no #MostlyPostly, no generic hashtags like #hairstylist — use service-specific ones like #balayage, #blondespecialist, etc.)
- DO NOT include "#MostlyPostly" — it is added automatically by the platform
- If "Notes" are provided, you MUST incorporate them into the caption — reference the service, technique, season, or context mentioned. Do not ignore notes.


## PART 2 — Content Classification:
- Used by messageRouter.js to set content_type on every stylist-submitted draft.
- "content_type" must be one of:
    "standard_post", "before_after", "education"
- "content_confidence" must be a number from 0 to 1

## REQUIRED JSON FORMAT
{
  "service_type": "...",
  "caption": "...",
  "hashtags": ["#..."],
  "cta": "...",
  "content_type": "standard_post",
  "content_confidence": 0.82
}
`;

  // ===========================
  // USER PROMPT
  // ===========================
  const userPrompt = `
  Salon: ${salonName} (${city || "unknown city"})
  Stylist: ${stylistName}
  Instagram: ${instagramHandle ? "@" + instagramHandle : "N/A"}
  Notes: ${notes || "None"}
  Image: ${imageDataUrl ? "Image provided" : "No image"}
  `;

  try {
    console.log("🧠 [OpenAI] Generating caption + classification…");

    const payload = {
      model,
      temperature: 0.8,
      messages: [
        { role: "system", content: systemPrompt.trim() },
        {
          role: "user",
          content: [
            { type: "text", text: userPrompt.trim() },
            ...(imageDataUrl
              ? [{ type: "image_url", image_url: { url: imageDataUrl } }]
              : []),
          ],
        },
      ],
    };

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error("❌ [OpenAI] API error:", resp.status, JSON.stringify(data));
      return fallbackCaption();
    }

    const raw = data?.choices?.[0]?.message?.content || "";
    const clean = sanitizeText(raw);

    const parsed =
      tryParseJSON(clean) ||
      tryParseJSON(clean.match(/\{[\s\S]*\}/)?.[0]) ||
      null;

    if (!parsed) {
      console.warn("⚠️ Failed to parse JSON reply from OpenAI. Raw response:", raw.slice(0, 500));
      return fallbackCaption();
    }

    const service_type = parsed.service_type || "other";
    const caption = parsed.caption || fallbackCaption().caption;
    const hashtags =
      Array.isArray(parsed.hashtags) && parsed.hashtags.length
        ? parsed.hashtags
        : ["#MostlyPostly"];
    const cta = parsed.cta || fallbackCaption().cta;

    const content_type = parsed.content_type || "standard_post";
    const content_confidence =
      typeof parsed.content_confidence === "number"
        ? Math.max(0, Math.min(1, parsed.content_confidence))
        : null;

    const result = {
      service_type,
      caption,
      hashtags,
      cta,
      _classification: {
        content_type,
        confidence: content_confidence,
      },
    };

    // ===========================
    // Shadow Analytics Logging
    // ===========================
    try {
      await logEvent({
        event: "post_classified_shadow",
        salon_id: salonId,
        post_id: null,
        data: {
          service_type,
          content_type,
          content_confidence,
          city,
          notes,
          stylist_name: stylistName,
          stylist_phone: stylist?.stylist_phone || stylist?.phone || null,
        },
      });
    } catch (e) {
      console.warn("⚠️ Failed to write AI analytics event:", e.message);
    }

    console.log("✨ [OpenAI] Caption:", result.caption);
    return result;
  } catch (err) {
    console.error("❌ [OpenAI] Fatal error:", err);
    return fallbackCaption();
  }
}
