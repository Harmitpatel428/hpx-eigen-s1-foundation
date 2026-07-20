import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

export class EmailService {
  private readonly ses: SESClient;
  private readonly fromEmail: string;

  constructor() {
    this.ses = new SESClient({
      region: process.env.SES_REGION || 'us-east-1'
    });
    this.fromEmail = process.env.SES_FROM_EMAIL || 'noreply@example.com';
  }

  async sendInvitationEmail(to: string, token: string) {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const inviteLink = `${frontendUrl}/auth/accept-invite?token=${token}`;

    const command = new SendEmailCommand({
      Destination: {
        ToAddresses: [to]
      },
      Message: {
        Body: {
          Html: {
            Charset: 'UTF-8',
            Data: `
              <h1>You have been invited!</h1>
              <p>You have been invited to join the platform.</p>
              <p>Click the link below to accept your invitation and set up your account:</p>
              <p><a href="${inviteLink}">${inviteLink}</a></p>
            `
          },
          Text: {
            Charset: 'UTF-8',
            Data: `You have been invited to join the platform. Accept your invitation here: ${inviteLink}`
          }
        },
        Subject: {
          Charset: 'UTF-8',
          Data: 'Invitation to join the platform'
        }
      },
      Source: this.fromEmail
    });

    try {
      await this.ses.send(command);
    } catch (error) {
      // We log the error but don't throw it, so the invitation is still created
      console.error('Failed to send invitation email:', error);
    }
  }
}
