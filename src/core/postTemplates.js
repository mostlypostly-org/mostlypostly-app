// src/core/postTemplates.js
// Shared post image template registry.
// TEMPLATES[postType][key] = buildHtml(opts) → HTML string
// opts shape: { width, height, photoDataUri, logoDataUri, firstName,
//               celebrationType, subLabel, accentHex }

function safe(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Color helpers ──────────────────────────────────────────────────────────

function hexLuminance(hex) {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return 0;
  const r = parseInt(hex.slice(1,3), 16) / 255;
  const g = parseInt(hex.slice(3,5), 16) / 255;
  const b = parseInt(hex.slice(5,7), 16) / 255;
  const toLinear = c => c <= 0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4);
  return 0.2126*toLinear(r) + 0.7152*toLinear(g) + 0.0722*toLinear(b);
}
// White text on dark bg, dark text on light bg
function textOnBg(bgHex) {
  return hexLuminance(bgHex) > 0.25 ? "#1a1c22" : "#ffffff";
}
function mutedOnBg(bgHex) {
  return hexLuminance(bgHex) > 0.25 ? "rgba(26,28,34,0.55)" : "rgba(255,255,255,0.55)";
}

// ─── Shared helpers ────────────────────────────────────────────────────────

function logoHtml(logoDataUri, width, height, pad) {
  if (!logoDataUri) return "";
  return `
  <div style="position:absolute;top:${Math.round(height*0.028)}px;right:${pad}px;
    background:rgba(0,0,0,0.28);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
    border-radius:${Math.round(height*0.012)}px;padding:${Math.round(height*0.012)}px ${Math.round(width*0.022)}px;
    display:flex;align-items:center;justify-content:center;">
    <img src="${logoDataUri}"
      style="max-width:${Math.round(width*0.20)}px;max-height:${Math.round(height*0.055)}px;
      object-fit:contain;display:block;filter:brightness(0) invert(1);" />
  </div>`;
}

function watermarkHtml(height, pad) {
  return `<div style="position:absolute;bottom:${Math.round(height*0.022)}px;left:${pad}px;
    font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;
    font-size:${Math.round(height*0.014)}px;font-weight:400;
    color:rgba(255,255,255,0.35);letter-spacing:0.5px;">#MostlyPostly</div>`;
}

// ─── Template 1: script — Handwritten Elegance ────────────────────────────

function buildHtml_script({ width, height, photoDataUri, logoDataUri, firstName, celebrationType, subLabel, accentHex }) {
  const pad = Math.round(width * 0.055);
  const nameFontSize   = Math.round(height * 0.165);
  const eyebrowFontSize = Math.round(height * 0.022);
  const subFontSize    = Math.round(height * 0.028);
  const eyebrow = celebrationType === "birthday" ? "Happy Birthday" : "Happy Anniversary";

  const photoBg = photoDataUri ? `
    <img style="position:absolute;inset:-30px;width:calc(100% + 60px);height:calc(100% + 60px);
      object-fit:cover;object-position:center top;filter:blur(22px) brightness(0.45) saturate(1.1);" src="${photoDataUri}" />
    <img style="position:absolute;top:0;left:0;width:100%;height:68%;
      object-fit:contain;object-position:center top;" src="${photoDataUri}" />`
    : `<div style="position:absolute;inset:0;background:linear-gradient(135deg,${accentHex}cc 0%,#1a1c22 100%);"></div>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Great+Vibes&family=Lato:wght@300;400&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}
body{width:${width}px;height:${height}px;overflow:hidden;position:relative;background:#1a1c22;}</style>
</head><body>
  ${photoBg}
  <div style="position:absolute;inset:0;background:linear-gradient(to bottom,rgba(0,0,0,0) 0%,rgba(0,0,0,0.08) 30%,rgba(0,0,0,0.60) 58%,rgba(0,0,0,0.90) 75%,rgba(0,0,0,0.97) 100%);"></div>
  <div style="position:absolute;bottom:0;left:0;right:0;padding:${Math.round(height*0.05)}px ${pad}px ${Math.round(height*0.07)}px;">
    <div style="width:${Math.round(width*0.075)}px;height:${Math.round(height*0.004)}px;background:${accentHex};border-radius:2px;margin-bottom:${Math.round(height*0.018)}px;"></div>
    <div style="font-family:'Great Vibes',cursive;font-size:${eyebrowFontSize * 2.2}px;color:rgba(255,255,255,0.85);margin-bottom:${Math.round(height*0.005)}px;line-height:1.1;">${safe(eyebrow)}</div>
    <div style="font-family:'Lato',sans-serif;font-size:${nameFontSize * 0.55}px;font-weight:700;color:#fff;letter-spacing:6px;text-transform:uppercase;line-height:1.05;text-shadow:0 4px 24px rgba(0,0,0,0.5);">${safe(firstName)}</div>
    ${subLabel ? `<div style="font-family:'Lato',sans-serif;font-size:${subFontSize}px;font-weight:300;color:rgba(255,255,255,0.65);margin-top:${Math.round(height*0.014)}px;letter-spacing:2px;">${safe(subLabel)}</div>` : ""}
  </div>
  ${logoHtml(logoDataUri, width, height, pad)}
  ${watermarkHtml(height, pad)}
</body></html>`;
}

// ─── Template 2: editorial — Magazine Split ────────────────────────────────

function buildHtml_editorial({ width, height, photoDataUri, logoDataUri, firstName, celebrationType, subLabel, accentHex, bandHex = "#1a1c22" }) {
  const pad = Math.round(width * 0.07);
  const splitPct = 0.56;
  const photoH = Math.round(height * splitPct);
  const bandH  = height - photoH;
  const nameFontSize   = Math.round(bandH * 0.38);
  const eyebrowFontSize = Math.round(bandH * 0.10);
  const subFontSize    = Math.round(bandH * 0.115);
  const eyebrow = celebrationType === "birthday" ? "HAPPY BIRTHDAY" : "HAPPY ANNIVERSARY";

  const photoBg = photoDataUri
    ? `<img style="position:absolute;top:0;left:0;width:100%;height:${photoH}px;object-fit:cover;object-position:center top;" src="${photoDataUri}" />`
    : `<div style="position:absolute;top:0;left:0;width:100%;height:${photoH}px;background:linear-gradient(135deg,${accentHex}99 0%,#1a1c22 100%);"></div>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700;800&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}
body{width:${width}px;height:${height}px;overflow:hidden;position:relative;background:#1a1c22;}</style>
</head><body>
  ${photoBg}
  <!-- Accent bar at split edge -->
  <div style="position:absolute;top:${photoH - 3}px;left:0;right:0;height:5px;background:${accentHex};"></div>
  <!-- Color band -->
  <div style="position:absolute;bottom:0;left:0;right:0;height:${bandH}px;background:${bandHex};
    display:flex;flex-direction:column;justify-content:center;padding:0 ${pad}px;">
    <div style="font-family:'Montserrat',sans-serif;font-size:${eyebrowFontSize}px;font-weight:400;
      color:${mutedOnBg(bandHex)};letter-spacing:${Math.round(eyebrowFontSize * 0.5)}px;
      text-transform:uppercase;margin-bottom:${Math.round(bandH * 0.04)}px;">${safe(eyebrow)}</div>
    <div style="font-family:'Montserrat',sans-serif;font-size:${nameFontSize}px;font-weight:800;
      color:${textOnBg(bandHex)};text-transform:uppercase;letter-spacing:2px;line-height:0.9;">${safe(firstName)}</div>
    ${subLabel ? `<div style="font-family:'Montserrat',sans-serif;font-size:${subFontSize}px;font-weight:400;
      color:${mutedOnBg(bandHex)};margin-top:${Math.round(bandH*0.06)}px;letter-spacing:3px;text-transform:uppercase;">${safe(subLabel)}</div>` : ""}
  </div>
  ${logoHtml(logoDataUri, width, height, Math.round(width * 0.055))}
  ${watermarkHtml(height, pad)}
</body></html>`;
}

// ─── Template 3: bold — Vertical Statement ────────────────────────────────

function buildHtml_bold({ width, height, photoDataUri, logoDataUri, firstName, celebrationType, subLabel, accentHex }) {
  const pad = Math.round(width * 0.055);
  const panelW = Math.round(width * 0.44);
  const nameFontSize   = Math.round(height * 0.13);
  const eyebrowFontSize = Math.round(panelW * 0.09);
  const typeFontSize   = Math.round(panelW * 0.13);
  const eyebrow = celebrationType === "birthday" ? "HAPPY BIRTHDAY" : "HAPPY ANNIVERSARY";
  const typeWord = celebrationType === "birthday" ? "CELEBRATING" : "MILESTONE";

  const photoBg = photoDataUri ? `
    <img style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:brightness(0.65);" src="${photoDataUri}" />`
    : `<div style="position:absolute;inset:0;background:linear-gradient(135deg,${accentHex}cc 0%,#1a1c22 100%);"></div>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@800&family=Lato:wght@300;400&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}
body{width:${width}px;height:${height}px;overflow:hidden;position:relative;background:#1a1c22;}</style>
</head><body>
  ${photoBg}
  <!-- Right dark panel -->
  <div style="position:absolute;top:0;right:0;width:${panelW}px;height:100%;
    background:rgba(0,0,0,0.78);
    display:flex;flex-direction:column;justify-content:center;
    padding:${Math.round(height*0.06)}px ${Math.round(panelW*0.12)}px;">
    <div style="width:${Math.round(panelW*0.18)}px;height:3px;background:${accentHex};margin-bottom:${Math.round(height*0.03)}px;"></div>
    <div style="font-family:'Lato',sans-serif;font-size:${eyebrowFontSize}px;font-weight:400;
      color:rgba(255,255,255,0.55);letter-spacing:${Math.round(eyebrowFontSize*0.35)}px;
      text-transform:uppercase;margin-bottom:${Math.round(height*0.02)}px;line-height:1.3;">${safe(eyebrow)}</div>
    <div style="font-family:'Montserrat',sans-serif;font-size:${typeFontSize}px;font-weight:800;
      color:${accentHex};text-transform:uppercase;letter-spacing:2px;">${safe(typeWord)}</div>
    ${subLabel ? `<div style="font-family:'Lato',sans-serif;font-size:${Math.round(panelW*0.08)}px;font-weight:300;
      color:rgba(255,255,255,0.5);margin-top:${Math.round(height*0.04)}px;letter-spacing:2px;">${safe(subLabel)}</div>` : ""}
  </div>
  <!-- Vertical name text — left strip -->
  <div style="position:absolute;left:0;top:0;bottom:0;width:${nameFontSize * 1.25}px;
    display:flex;align-items:center;justify-content:center;">
    <div style="writing-mode:vertical-rl;transform:rotate(180deg);
      font-family:'Montserrat',sans-serif;font-size:${nameFontSize}px;font-weight:800;
      color:rgba(255,255,255,0.92);text-transform:uppercase;letter-spacing:8px;
      text-shadow:0 4px 32px rgba(0,0,0,0.6);">${safe(firstName)}</div>
  </div>
  ${logoHtml(logoDataUri, width, height, pad)}
  ${watermarkHtml(height, pad)}
</body></html>`;
}

// ─── Template 4: luxury — Frosted Card ────────────────────────────────────

function buildHtml_luxury({ width, height, photoDataUri, logoDataUri, firstName, celebrationType, subLabel, accentHex }) {
  const pad = Math.round(width * 0.055);
  const cardW = Math.round(width * 0.74);
  const nameFontSize    = Math.round(height * 0.085);
  const eyebrowFontSize = Math.round(height * 0.019);
  const subFontSize     = Math.round(height * 0.022);
  const eyebrow = celebrationType === "birthday" ? "Happy Birthday" : "Happy Anniversary";

  const photoBg = photoDataUri ? `
    <img style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:brightness(0.45) saturate(0.9);" src="${photoDataUri}" />`
    : `<div style="position:absolute;inset:0;background:linear-gradient(135deg,${accentHex}99 0%,#1a1c22 100%);"></div>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;1,400;1,700&family=Lato:wght@300;400&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}
body{width:${width}px;height:${height}px;overflow:hidden;position:relative;background:#1a1c22;}</style>
</head><body>
  ${photoBg}
  <!-- Frosted glass card, centered -->
  <div style="position:absolute;left:50%;top:63%;transform:translate(-50%,-50%);
    width:${cardW}px;
    background:rgba(255,255,255,0.11);
    backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
    border:1px solid rgba(255,255,255,0.18);
    border-radius:${Math.round(height*0.025)}px;
    padding:${Math.round(height*0.065)}px ${Math.round(cardW*0.10)}px;
    text-align:center;">
    <div style="font-family:'Lato',sans-serif;font-size:${eyebrowFontSize}px;font-weight:300;
      color:rgba(255,255,255,0.6);letter-spacing:${Math.round(eyebrowFontSize*0.7)}px;
      text-transform:uppercase;margin-bottom:${Math.round(height*0.03)}px;">${safe(eyebrow)}</div>
    <!-- Thin divider -->
    <div style="width:${Math.round(cardW*0.22)}px;height:1px;background:${accentHex};
      margin:0 auto ${Math.round(height*0.04)}px;opacity:0.8;"></div>
    <div style="font-family:'Playfair Display',serif;font-size:${nameFontSize}px;font-style:italic;font-weight:700;
      color:#fff;line-height:1.1;text-shadow:0 2px 16px rgba(0,0,0,0.4);">${safe(firstName)}</div>
    ${subLabel ? `
    <div style="width:${Math.round(cardW*0.22)}px;height:1px;background:rgba(255,255,255,0.2);
      margin:${Math.round(height*0.04)}px auto ${Math.round(height*0.03)}px;"></div>
    <div style="font-family:'Lato',sans-serif;font-size:${subFontSize}px;font-weight:300;
      color:rgba(255,255,255,0.6);letter-spacing:3px;text-transform:uppercase;">${safe(subLabel)}</div>` : ""}
  </div>
  ${logoHtml(logoDataUri, width, height, pad)}
  ${watermarkHtml(height, pad)}
</body></html>`;
}

// ─── Template 5: minimal — Moody Centered ─────────────────────────────────

function buildHtml_minimal({ width, height, photoDataUri, logoDataUri, firstName, celebrationType, subLabel, accentHex }) {
  const pad = Math.round(width * 0.055);
  const nameFontSize    = Math.round(height * 0.12);
  const eyebrowFontSize = Math.round(height * 0.018);
  const pillFontSize    = Math.round(height * 0.016);
  const eyebrow = celebrationType === "birthday" ? "HAPPY BIRTHDAY" : "HAPPY ANNIVERSARY";

  const photoBg = photoDataUri ? `
    <img style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:brightness(0.3) saturate(0.8);" src="${photoDataUri}" />`
    : `<div style="position:absolute;inset:0;background:#0f1015;"></div>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@200;300&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}
body{width:${width}px;height:${height}px;overflow:hidden;position:relative;background:#0f1015;}</style>
</head><body>
  ${photoBg}
  <!-- Centered content -->
  <div style="position:absolute;inset:0;display:flex;flex-direction:column;
    align-items:center;justify-content:center;text-align:center;
    padding:${Math.round(height*0.08)}px ${Math.round(width*0.10)}px;">
    <div style="font-family:'Montserrat',sans-serif;font-size:${eyebrowFontSize}px;font-weight:300;
      color:rgba(255,255,255,0.45);letter-spacing:${Math.round(eyebrowFontSize*0.9)}px;
      text-transform:uppercase;margin-bottom:${Math.round(height*0.03)}px;">${safe(eyebrow)}</div>
    <div style="font-family:'Montserrat',sans-serif;font-size:${nameFontSize}px;font-weight:200;
      color:#fff;letter-spacing:4px;line-height:1.05;">${safe(firstName)}</div>
    <!-- Thin line -->
    <div style="width:${Math.round(width*0.12)}px;height:1px;background:${accentHex};
      margin:${Math.round(height*0.035)}px auto;"></div>
    ${subLabel ? `<div style="font-family:'Montserrat',sans-serif;font-size:${Math.round(height*0.020)}px;font-weight:300;
      color:rgba(255,255,255,0.5);letter-spacing:3px;text-transform:uppercase;
      margin-bottom:${Math.round(height*0.03)}px;">${safe(subLabel)}</div>` : ""}
    <!-- Pill -->
    <div style="display:inline-block;background:${accentHex};border-radius:999px;
      padding:${Math.round(height*0.012)}px ${Math.round(width*0.07)}px;
      font-family:'Montserrat',sans-serif;font-size:${pillFontSize}px;font-weight:300;
      color:rgba(255,255,255,0.9);letter-spacing:${Math.round(pillFontSize*0.4)}px;
      text-transform:uppercase;">
      ${safe(celebrationType === "birthday" ? "Celebrating You" : "Thank You")}
    </div>
  </div>
  ${logoHtml(logoDataUri, width, height, pad)}
  ${watermarkHtml(height, pad)}
</body></html>`;
}

// ─── Registry ──────────────────────────────────────────────────────────────

export const TEMPLATE_META = {
  celebration: {
    script:    { label: "Handwritten Elegance", desc: "Script font · Photo-first" },
    editorial: { label: "Magazine Split",       desc: "Bold type · Color band" },
    bold:      { label: "Vertical Statement",   desc: "High-impact · Vertical name" },
    luxury:    { label: "Frosted Card",         desc: "Frosted glass · Serif italic" },
    minimal:   { label: "Moody Centered",       desc: "Minimal · Dark mood" },
  },
};

export const TEMPLATES = {
  celebration: {
    script:    buildHtml_script,
    editorial: buildHtml_editorial,
    bold:      buildHtml_bold,
    luxury:    buildHtml_luxury,
    minimal:   buildHtml_minimal,
  },
};
