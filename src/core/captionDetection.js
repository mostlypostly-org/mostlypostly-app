// src/core/captionDetection.js
// Pure heuristic: detect whether a stylist's message body is a real caption
// vs. a short label/direction for AI generation.
//
// Returns true if the text should be kept verbatim (passthrough).
// Returns false if AI should generate the caption.

export function isRealCaption(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  // Emoji detection (Unicode property escapes — Node 12+)
  const hasEmoji = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/u.test(trimmed);
  const startsCapital = /^[A-Z]/.test(trimmed);
  const hasPunctuation = /[.!?,]/.test(trimmed);

  // Primary path: 8+ words AND at least one secondary signal
  if (wordCount >= 8 && (startsCapital || hasPunctuation || hasEmoji)) return true;

  // Emoji path: emoji present AND 5+ words AND at least one secondary signal
  if (hasEmoji && wordCount >= 5 && (startsCapital || hasPunctuation)) return true;

  return false;
}
