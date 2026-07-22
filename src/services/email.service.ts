import { Resend } from 'resend';

// We'll initialize it with an empty string if undefined to avoid runtime errors before it's set
const resend = new Resend(process.env.RESEND_API_KEY || 're_placeholder');

export class EmailService {
  async sendVerificationEmail(email: string, token: string): Promise<void> {
    const verifyUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/verify-email?token=${token}`;

    try {
      await resend.emails.send({
        from: 'HPX Eigen <noreply@hpx-eigen.com>',
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
    } catch (error) {
      console.error('Failed to send verification email:', error);
      // We don't throw here to prevent blocking signup if email fails in dev without a real key
    }
  }
}

export const emailService = new EmailService();
