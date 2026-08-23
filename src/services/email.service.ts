import { Resend } from 'resend';

const RESEND_API_KEY = process.env.RESEND_API_KEY ?? '';
const resend = new Resend(RESEND_API_KEY || 're_placeholder');

// Sends happen wherever a working API key is configured — local included.
// Without a key we log the action link instead, so the auth flow still works
// end-to-end on a fresh checkout. (The old NODE_ENV gate silently disabled
// all mail outside production and made local verification impossible.)
const canSend = () => RESEND_API_KEY.startsWith('re_');

export class EmailService {
  async sendVerificationEmail(email: string, token: string): Promise<void> {
    const verifyUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/verify-email?token=${token}`;

    if (!canSend()) {
      console.log(`\n[DEV MODE] Verification URL: ${verifyUrl}\n`);
      return;
    }

    await resend.emails.send({
      from: 'HPX Eigen <noreply@hpxeigen.com>',
      to: email,
      subject: 'Verify your HPX Eigen account',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #0f172a; line-height: 1.6;">
          <div style="max-width: 600px; margin: 0 auto; padding: 32px;">
            <h2 style="margin: 0 0 24px 0; font-size: 28px; font-weight: 700;">Welcome to HPX Eigen CRM</h2>
            <p style="margin: 0 0 24px 0; color: #334155; font-size: 16px;">Click the link below to verify your email and activate your account:</p>
            <a href="${verifyUrl}" style="display: inline-block; background: #0f172a; color: white; padding: 12px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 24px 0;">Verify Email</a>
            <p style="margin: 24px 0 0 0; color: #64748b; font-size: 14px;">This link expires in 15 minutes.</p>
            <hr style="margin: 32px 0; border: none; border-top: 1px solid #e2e8f0;" />
            <p style="margin: 0; color: #94a3b8; font-size: 12px;">HPX Eigen CRM — Relationship Intelligence for the Modern Enterprise</p>
          </div>
        </div>
      `
    });
  }

  async sendPasswordResetEmail(email: string, token: string): Promise<void> {
    const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password?token=${token}`;

    if (!canSend()) {
      console.log(`\n[DEV MODE] Password Reset URL: ${resetUrl}\n`);
      return;
    }

    await resend.emails.send({
      from: 'HPX Eigen <noreply@hpxeigen.com>',
      to: email,
      subject: 'Reset your HPX Eigen password',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #0f172a; line-height: 1.6;">
          <div style="max-width: 600px; margin: 0 auto; padding: 32px;">
            <h2 style="margin: 0 0 24px 0; font-size: 28px; font-weight: 700;">Password Reset Request</h2>
            <p style="margin: 0 0 24px 0; color: #334155; font-size: 16px;">Click the link below to reset your password. This link expires in 15 minutes.</p>
            <a href="${resetUrl}" style="display: inline-block; background: #0f172a; color: white; padding: 12px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 24px 0;">Reset Password</a>
            <p style="margin: 24px 0 0 0; color: #64748b; font-size: 14px;">If you did not request this, you can safely ignore this email.</p>
            <hr style="margin: 32px 0; border: none; border-top: 1px solid #e2e8f0;" />
            <p style="margin: 0; color: #94a3b8; font-size: 12px;">HPX Eigen CRM — Relationship Intelligence for the Modern Enterprise</p>
          </div>
        </div>
      `
    });
  }

  async sendPasswordChangedEmail(email: string): Promise<void> {
    if (!canSend()) {
      console.log(`\n[DEV MODE] Password changed notification would be sent to: ${email}\n`);
      return;
    }

    const timestamp = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

    await resend.emails.send({
      from: 'HPX Eigen <noreply@hpxeigen.com>',
      to: email,
      subject: 'Your HPX Eigen password was changed',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #0f172a; line-height: 1.6;">
          <div style="max-width: 600px; margin: 0 auto; padding: 32px;">
            <h2 style="margin: 0 0 24px 0; font-size: 28px; font-weight: 700;">Password Changed</h2>
            <p style="margin: 0 0 16px 0; color: #334155; font-size: 16px;">Your HPX Eigen CRM password was successfully changed on ${timestamp}.</p>
            <p style="margin: 0 0 24px 0; color: #334155; font-size: 16px;">If you did not make this change, please contact your administrator immediately and reset your password.</p>
            <hr style="margin: 32px 0; border: none; border-top: 1px solid #e2e8f0;" />
            <p style="margin: 0; color: #94a3b8; font-size: 12px;">HPX Eigen CRM — Relationship Intelligence for the Modern Enterprise</p>
          </div>
        </div>
      `
    });
  }

  // acceptUrl contains the raw token — never log this URL in production
  async sendInvitationEmail(to: string, acceptUrl: string, roleName: string, expiresAt: Date): Promise<void> {
    if (process.env.NODE_ENV !== 'production') {
      // Intentional skip — caller must set emailStatus = SKIPPED
      return;
    }

    const expiryStr = expiresAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    // throws on Resend error — caller wraps in try/catch and sets emailStatus = FAILED
    await resend.emails.send({
      from: 'HPX Eigen <noreply@hpxeigen.com>',
      to,
      subject: `You've been invited to join HPX Eigen CRM`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #0f172a; line-height: 1.6;">
          <div style="max-width: 600px; margin: 0 auto; padding: 32px;">
            <h2 style="margin: 0 0 24px 0; font-size: 28px; font-weight: 700;">You've been invited</h2>
            <p style="margin: 0 0 24px 0; color: #334155; font-size: 16px;">
              You've been invited to join HPX Eigen CRM as <strong>${roleName}</strong>.
            </p>
            <a href="${acceptUrl}" style="display: inline-block; background: #0f172a; color: white; padding: 12px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 24px 0;">Accept Invitation</a>
            <p style="margin: 24px 0 0 0; color: #64748b; font-size: 14px;">This invitation expires on ${expiryStr}.</p>
            <hr style="margin: 32px 0; border: none; border-top: 1px solid #e2e8f0;" />
            <p style="margin: 0; color: #94a3b8; font-size: 12px;">HPX Eigen CRM — Relationship Intelligence for the Modern Enterprise</p>
          </div>
        </div>
      `
    });
  }
}

export const emailService = new EmailService();
