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
<body style="margin:0;padding:0;background:#F8FAFC;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <span style="display:none;max-height:0;overflow:hidden;">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</span>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">

        <!-- Card -->
        <tr><td style="background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden;">
          <table width="100%" cellpadding="0" cellspacing="0">

            <!-- Blue header band with logo -->
            <tr><td style="background:#3B72B9;padding:20px 32px;">
              <img src="https://mostlypostly.com/logo/MostlyPostly%20Logo%20-%20Primary%20(Trimmed).png"
                   alt="MostlyPostly" height="28"
                   style="display:block;border:0;outline:none;text-decoration:none;filter:brightness(0) invert(1);" />
            </td></tr>

            <!-- Body content -->
            <tr><td style="padding:36px 32px;">
              ${body}
            </td></tr>

            <!-- Card footer rule -->
            <tr><td style="padding:0 32px 28px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr><td style="border-top:1px solid #E2E8F0;padding-top:20px;font-size:12px;color:#9CA3AF;line-height:1.6;">
                  You received this email because you have a MostlyPostly account.<br />
                  <a href="https://mostlypostly.com/legal/privacy.html" style="color:#9CA3AF;text-decoration:underline;">Privacy Policy</a> &nbsp;·&nbsp;
                  <a href="https://mostlypostly.com/legal/terms.html" style="color:#9CA3AF;text-decoration:underline;">Terms of Service</a>
                </td></tr>
              </table>
            </td></tr>

          </table>
        </td></tr>

        <!-- Below-card footer -->
        <tr><td style="padding:20px 0 0;text-align:center;font-size:12px;color:#9CA3AF;line-height:1.6;">
          MostlyPostly &nbsp;·&nbsp; Carmel, Indiana
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
        <p style="margin:0 0 24px;font-size:15px;color:#6B7280;line-height:1.7;">
          Hi ${name || "there"}, thanks for signing up for MostlyPostly!<br />
          Click the button below to verify your email and activate your account.
        </p>
        <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
          <tr><td style="background:#3B72B9;border-radius:999px;padding:14px 32px;">
            <a href="${verifyUrl}" style="color:#fff;font-size:14px;font-weight:700;text-decoration:none;display:block;white-space:nowrap;">
              Verify my email →
            </a>
          </td></tr>
        </table>
        <p style="margin:0 0 8px;font-size:12px;color:#9CA3AF;line-height:1.6;">
          This link expires in 24 hours. If you didn't sign up for MostlyPostly, you can safely ignore this email.
        </p>
        <p style="margin:0;font-size:12px;color:#9CA3AF;">
          Or copy this link into your browser:<br />
          <a href="${verifyUrl}" style="color:#3B72B9;word-break:break-all;">${verifyUrl}</a>
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
        <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#2B2D35;">Welcome aboard.</h1>
        <p style="margin:0 0 24px;font-size:15px;color:#6B7280;line-height:1.7;">
          Hi ${name || "there"}, your MostlyPostly account for <strong style="color:#2B2D35;">${salonName}</strong> is active and ready to go. Here's what to do next:
        </p>
        <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;width:100%;">
          ${[
            ["1", "Add your stylists", "Register each stylist by phone number — they text photos directly from their own phone. No app download required."],
            ["2", "Connect Facebook &amp; Instagram", "Link your pages so posts publish automatically on your salon's schedule."],
            ["3", "Set your brand voice", "Enter your booking URL, brand tone, and default hashtags so every caption sounds like you."],
          ].map(([num, title, desc]) => `
            <tr>
              <td style="padding:14px 0;border-bottom:1px solid #E2E8F0;vertical-align:top;">
                <table cellpadding="0" cellspacing="0"><tr>
                  <td style="width:28px;vertical-align:top;padding-top:1px;">
                    <span style="display:inline-block;width:22px;height:22px;background:#EBF3FF;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:800;color:#3B72B9;">${num}</span>
                  </td>
                  <td style="padding-left:12px;vertical-align:top;">
                    <strong style="font-size:13px;color:#2B2D35;display:block;margin-bottom:2px;">${title}</strong>
                    <span style="font-size:12px;color:#6B7280;line-height:1.6;">${desc}</span>
                  </td>
                </tr></table>
              </td>
            </tr>
          `).join("")}
        </table>
        <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
          <tr><td style="background:#3B72B9;border-radius:999px;padding:14px 32px;">
            <a href="${dashUrl}" style="color:#fff;font-size:14px;font-weight:700;text-decoration:none;display:block;white-space:nowrap;">
              Go to my dashboard →
            </a>
          </td></tr>
        </table>
        <p style="margin:0;font-size:12px;color:#9CA3AF;line-height:1.6;">
          Questions? Reply to this email or reach us at
          <a href="mailto:support@mostlypostly.com" style="color:#3B72B9;">support@mostlypostly.com</a>
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
        <p style="margin:0 0 16px;font-size:14px;color:#6B7280;line-height:1.6;">
          Hi ${name || "there"}, your MostlyPostly subscription has been cancelled.
        </p>
        <table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 24px;background:#EBF3FF;border-radius:12px;">
          <tr><td style="padding:20px 24px;">
            <p style="margin:0 0 4px;font-size:12px;font-weight:700;color:#2B2D35;text-transform:uppercase;letter-spacing:0.05em;">Your access continues until</p>
            <p style="margin:0;font-size:20px;font-weight:800;color:#2B2D35;">${formattedDate}</p>
          </td></tr>
        </table>
        <p style="margin:0 0 24px;font-size:14px;color:#6B7280;line-height:1.6;">
          After that date, your account will be suspended and new posts won't be published. Your salon data and post history will be retained for 90 days in case you'd like to reactivate.
        </p>
        <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
          <tr><td style="background:#2B2D35;border-radius:999px;padding:14px 32px;">
            <a href="${billingUrl}" style="color:#fff;font-size:14px;font-weight:700;text-decoration:none;display:block;">
              Reactivate my account →
            </a>
          </td></tr>
        </table>
        <p style="margin:0;font-size:12px;color:#6B7280;line-height:1.6;">
          Changed your mind? You can reactivate anytime from your billing page. Questions? Email us at
          <a href="mailto:support@mostlypostly.com" style="color:#3B72B9;">support@mostlypostly.com</a>.
        </p>
      `,
    }),
  });
}
