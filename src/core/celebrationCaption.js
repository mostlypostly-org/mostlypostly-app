// src/core/celebrationCaption.js
// Generates birthday/anniversary captions via GPT-4o-mini with template fallback.
// Always appends #MostlyPostly.

import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const FALLBACKS = {
  birthday: (name, salonName) =>
    `Happy Birthday ${name}! 🎂 We're so lucky to have you on our team. — ${salonName} #MostlyPostly`,
  anniversary: (name, years, salonName) =>
    `Happy Anniversary ${name}! 🎉 Thank you for everything you bring to our team. — ${salonName} #MostlyPostly`,
};

/**
 * @param {object} opts
 * @param {string} opts.firstName
 * @param {string} opts.salonName
 * @param {string} [opts.tone]
 * @param {"birthday"|"anniversary"} opts.celebrationType
 * @param {number} [opts.anniversaryYears]
 * @returns {Promise<string>}
 */
export async function generateCelebrationCaption({
  firstName,
  salonName,
  tone = "warm and professional",
  celebrationType,
  anniversaryYears,
}) {
  try {
    const typeDesc = celebrationType === "birthday"
      ? `${firstName}'s birthday`
      : `${firstName}'s ${anniversaryYears}-year work anniversary at ${salonName}`;

    const prompt = `Write a short, warm social media caption celebrating ${typeDesc}.
Tone: ${tone}.
Keep it under 3 sentences. Feel genuine, not corporate.
End with: #MostlyPostly
Do not use any hashtags other than #MostlyPostly.
Do not wrap the caption in quotation marks.`;

    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 120,
      temperature: 0.8,
    });

    const text = resp.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("Empty response from OpenAI");
    return text.includes("#MostlyPostly") ? text : `${text} #MostlyPostly`;
  } catch (err) {
    console.warn("[celebrationCaption] AI failed, using fallback:", err.message);
    return celebrationType === "birthday"
      ? FALLBACKS.birthday(firstName, salonName)
      : FALLBACKS.anniversary(firstName, anniversaryYears, salonName);
  }
}
