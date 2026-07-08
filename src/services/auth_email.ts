import { Resend } from "resend";
import { config } from "../config";
import { logger } from "../logger";

const resend = new Resend(config.RESEND_API_KEY);

const OTP_TTL_MINUTES = 10;

// Interval Insights brand palette (source of truth: app lib/common/utils/app_theme.dart)
const NAVY = "#0f0a51";
const ACCENT = "#98d2eb";
const BACKGROUND = "#F1F5F9";

function otpEmailHtml(otp: string): string {
  const logoUrl = new URL("/app-icon.png", config.APP_BASE_URL).toString();
  return `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background-color:${BACKGROUND};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BACKGROUND};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background-color:#ffffff;border-radius:16px;overflow:hidden;">
        <tr>
          <td align="center" style="background-color:${NAVY};padding:28px 24px;">
            <img src="${logoUrl}" alt="Interval Insights" width="56" height="56" style="border-radius:12px;display:block;margin:0 auto 12px;" />
            <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:0.3px;">Interval Insights</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 8px;">
            <h1 style="margin:0 0 8px;color:${NAVY};font-size:22px;font-weight:700;">Log in to Interval Insights</h1>
            <p style="margin:0 0 24px;color:#475569;font-size:15px;line-height:1.6;">Enter this code in the app to log in. It expires in ${OTP_TTL_MINUTES} minutes.</p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:0 32px;">
            <div style="background-color:${BACKGROUND};border:2px solid ${ACCENT};border-radius:12px;padding:20px 0;">
              <span style="font-family:'SF Mono',SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace;font-size:34px;font-weight:700;letter-spacing:12px;color:${NAVY};padding-left:12px;">${otp}</span>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 32px 32px;">
            <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.6;">If you didn't request this code, you can safely ignore this email — no one can log in without it.</p>
          </td>
        </tr>
      </table>
      <p style="margin:16px 0 0;color:#94a3b8;font-size:12px;">Interval Insights · intervalinsights.cvebbesen.no</p>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Deliver the sign-in OTP via Resend. Outside production the email is not sent —
 * the code is logged instead so local flows can be exercised without a real
 * Resend key (and without spamming real inboxes from dev machines).
 */
export async function sendSignInOtpEmail(email: string, otp: string): Promise<void> {
  if (config.NODE_ENV !== "production") {
    logger.info({ email, otp }, "sign-in OTP (dev mode — email not sent)");
    return;
  }
  const { error } = await resend.emails.send({
    from: "Interval Insights <login@intervalinsights.cvebbesen.no>",
    to: email,
    subject: `${otp} is your Interval Insights login code`,
    html: otpEmailHtml(otp),
    text: `Your Interval Insights login code is ${otp}. It expires in ${OTP_TTL_MINUTES} minutes. If you didn't request this code, you can safely ignore this email.`,
  });
  if (error) {
    logger.error({ error, email }, "Failed to send sign-in OTP email");
    throw new Error(`OTP email delivery failed: ${error.message}`);
  }
}
