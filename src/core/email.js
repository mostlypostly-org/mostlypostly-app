// src/core/email.js
// Resend email helper. All outbound emails go through here.
// Requires RESEND_API_KEY env var. Fails gracefully (logs, does not throw) if not configured.

import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM = process.env.EMAIL_FROM || "hello@mostlypostly.com";
const BASE_URL = (process.env.PUBLIC_BASE_URL || "https://app.mostlypostly.com").replace(/\/$/, "");

// ─── Low-level send ────────────────────────────────────────────────────────────
export async function sendEmail({ to, subject, html }) {
  if (!resend) {
    console.warn("[email] RESEND_API_KEY not set — skipping email to", to);
    return;
  }
  try {
    const { data, error } = await resend.emails.send({ from: FROM, to, subject, html });
    if (error) console.error("[email] Resend error:", error);
    else console.log("[email] Sent to", to, "id:", data?.id);
  } catch (err) {
    console.error("[email] Send failed:", err.message);
  }
}

// ─── Email templates ──────────────────────────────────────────────────────────

function emailWrapper({ preheader, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>MostlyPostly</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background:#FDF8F6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <span style="display:none;max-height:0;overflow:hidden;">${preheader}</span>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#FDF8F6;padding:32px 0;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">

        <!-- Header -->
        <tr><td style="padding:0 0 24px 0;text-align:left;">
          <img src="https://mostlypostly.com/logo/MostlyPostly%20Logo%20-%20Primary%20(Trimmed).png"
               alt="MostlyPostly" height="36" style="display:block;" />
        </td></tr>

        <!-- Card -->
        <tr><td style="background:#fff;border:1px solid #EDE7E4;border-radius:16px;padding:36px 40px;">
          ${body}
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:24px 0 0 0;text-align:center;font-size:12px;color:#7A7C85;line-height:1.6;">
          MostlyPostly · Carmel, Indiana<br />
          <a href="https://mostlypostly.com/legal/privacy.html" style="color:#7A7C85;">Privacy Policy</a> ·
          <a href="https://mostlypostly.com/legal/terms.html" style="color:#7A7C85;">Terms</a>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Verification email ───────────────────────────────────────────────────────
export async function sendVerificationEmail({ to, name, token }) {
  const verifyUrl = `${BASE_URL}/manager/verify-email?token=${token}`;
  await sendEmail({
    to,
    subject: "Verify your email — MostlyPostly",
    html: emailWrapper({
      preheader: "One click to confirm your email and start your free trial.",
      body: `
        <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#2B2D35;">You're almost in.</h1>
        <p style="margin:0 0 24px;font-size:14px;color:#7A7C85;line-height:1.6;">
          Hi ${name || "there"}, thanks for signing up for MostlyPostly!<br />
          Click the button below to verify your email and activate your account.
        </p>
        <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
          <tr><td style="background:#2B2D35;border-radius:999px;padding:14px 32px;">
            <a href="${verifyUrl}" style="color:#fff;font-size:14px;font-weight:700;text-decoration:none;display:block;">
              Verify my email →
            </a>
          </td></tr>
        </table>
        <p style="margin:0 0 8px;font-size:12px;color:#7A7C85;line-height:1.6;">
          This link expires in 24 hours. If you didn't sign up for MostlyPostly, you can safely ignore this email.
        </p>
        <p style="margin:0;font-size:12px;color:#7A7C85;">
          Or copy this URL into your browser:<br />
          <a href="${verifyUrl}" style="color:#D4897A;word-break:break-all;">${verifyUrl}</a>
        </p>
      `,
    }),
  });
}

// ─── Welcome email (sent after verification) ──────────────────────────────────
export async function sendWelcomeEmail({ to, name, salonName }) {
  const dashUrl = `${BASE_URL}/manager`;
  await sendEmail({
    to,
    subject: `Welcome to MostlyPostly, ${name || salonName}!`,
    html: emailWrapper({
      preheader: "Your salon's social presence just got a lot easier.",
      body: `
        <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#2B2D35;">Welcome aboard! 🎉</h1>
        <p style="margin:0 0 16px;font-size:14px;color:#7A7C85;line-height:1.6;">
          Hi ${name || "there"}, your MostlyPostly account for <strong style="color:#2B2D35;">${salonName}</strong> is active and ready to go.
        </p>
        <p style="margin:0 0 24px;font-size:14px;color:#7A7C85;line-height:1.6;">
          Here's what to do next:
        </p>
        <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;width:100%;">
          ${[
            ["📸", "Add your stylists", "Each stylist gets registered by phone number — they'll text photos directly from their own phone."],
            ["🎨", "Set your brand colors", "We'll auto-extract them from your website, or you can enter them manually."],
            ["📱", "Connect Facebook & Instagram", "Link your pages so posts can publish automatically on schedule."],
          ].map(([icon, title, desc]) => `
            <tr>
              <td style="padding:12px 0;vertical-align:top;border-bottom:1px solid #EDE7E4;">
                <table cellpadding="0" cellspacing="0"><tr>
                  <td style="width:36px;font-size:20px;vertical-align:middle;">${icon}</td>
                  <td style="padding-left:12px;vertical-align:middle;">
                    <strong style="font-size:13px;color:#2B2D35;display:block;">${title}</strong>
                    <span style="font-size:12px;color:#7A7C85;line-height:1.5;">${desc}</span>
                  </td>
                </tr></table>
              </td>
            </tr>
          `).join("")}
        </table>
        <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
          <tr><td style="background:#D4897A;border-radius:999px;padding:14px 32px;">
            <a href="${dashUrl}" style="color:#fff;font-size:14px;font-weight:700;text-decoration:none;display:block;">
              Go to my dashboard →
            </a>
          </td></tr>
        </table>
        <p style="margin:0;font-size:12px;color:#7A7C85;line-height:1.6;">
          Questions? Reply to this email or reach us at
          <a href="mailto:support@mostlypostly.com" style="color:#D4897A;">support@mostlypostly.com</a> — we're here to help.
        </p>
      `,
    }),
  });
}

// ─── Cancellation confirmation email ─────────────────────────────────────────
export async function sendCancellationEmail({ to, name, accessEndsAt }) {
  const billingUrl = `${BASE_URL}/manager/billing`;
  const formattedDate = accessEndsAt
    ? new Date(accessEndsAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : "your current billing period end";
  await sendEmail({
    to,
    subject: "Your MostlyPostly subscription has been cancelled",
    html: emailWrapper({
      preheader: `Your access continues until ${formattedDate}.`,
      body: `
        <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#2B2D35;">We're sorry to see you go.</h1>
        <p style="margin:0 0 16px;font-size:14px;color:#7A7C85;line-height:1.6;">
          Hi ${name || "there"}, your MostlyPostly subscription has been cancelled.
        </p>
        <table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 24px;background:#F2DDD9;border-radius:12px;">
          <tr><td style="padding:20px 24px;">
            <p style="margin:0 0 4px;font-size:12px;font-weight:700;color:#2B2D35;text-transform:uppercase;letter-spacing:0.05em;">Your access continues until</p>
            <p style="margin:0;font-size:20px;font-weight:800;color:#2B2D35;">${formattedDate}</p>
          </td></tr>
        </table>
        <p style="margin:0 0 24px;font-size:14px;color:#7A7C85;line-height:1.6;">
          After that date, your account will be suspended and new posts won't be published. Your salon data and post history will be retained for 90 days in case you'd like to reactivate.
        </p>
        <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
          <tr><td style="background:#2B2D35;border-radius:999px;padding:14px 32px;">
            <a href="${billingUrl}" style="color:#fff;font-size:14px;font-weight:700;text-decoration:none;display:block;">
              Reactivate my account →
            </a>
          </td></tr>
        </table>
        <p style="margin:0;font-size:12px;color:#7A7C85;line-height:1.6;">
          Changed your mind? You can reactivate anytime from your billing page. Questions? Email us at
          <a href="mailto:support@mostlypostly.com" style="color:#D4897A;">support@mostlypostly.com</a>.
        </p>
      `,
    }),
  });
}
