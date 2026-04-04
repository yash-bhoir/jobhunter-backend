const nodemailer = require('nodemailer');
const logger = require('./logger');

let transporter;

const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT) || 465,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return transporter;
};

const sendEmail = async ({ to, subject, html }) => {
  try {
    const info = await getTransporter().sendMail({
      from: process.env.EMAIL_FROM || 'JobHunter <noreply@jobhunter.in>',
      to,
      subject,
      html,
    });
    logger.debug(`Email sent to ${to}: ${info.messageId}`);
    return info;
  } catch (err) {
    logger.error(`Email failed to ${to}: ${err.message}`);
    throw err;
  }
};

const templates = {
  verifyEmail: (name, token, baseUrl) => ({
    subject: 'Verify your JobHunter account',
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#2563eb">Welcome to JobHunter, ${name}!</h2>
        <p>Click the button below to verify your email address:</p>
        <a href="${baseUrl}/verify-email?token=${token}"
           style="display:inline-block;background:#2563eb;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">
          Verify Email
        </a>
        <p style="color:#888;margin-top:20px">This link expires in 24 hours.</p>
        <p style="color:#888">If you did not create an account, ignore this email.</p>
      </div>
    `,
  }),

  resetPassword: (name, token, baseUrl) => ({
    subject: 'Reset your JobHunter password',
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#2563eb">Password Reset Request</h2>
        <p>Hi ${name}, click below to reset your password:</p>
        <a href="${baseUrl}/reset-password?token=${token}"
           style="display:inline-block;background:#2563eb;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">
          Reset Password
        </a>
        <p style="color:#888;margin-top:20px">This link expires in 1 hour.</p>
        <p style="color:#888">If you did not request this, ignore this email.</p>
      </div>
    `,
  }),

  welcomePro: (name) => ({
    subject: 'Welcome to JobHunter Pro!',
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#2563eb">You are now on Pro, ${name}!</h2>
        <p>You now have access to:</p>
        <ul>
          <li>Unlimited job searches across all 9 platforms</li>
          <li>Verified HR email finding</li>
          <li>AI-powered outreach emails</li>
          <li>Excel export</li>
        </ul>
        <a href="${process.env.CLIENT_URL}/search"
           style="display:inline-block;background:#2563eb;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">
          Start Searching
        </a>
      </div>
    `,
  }),

  lowCredits: (name, remaining) => ({
    subject: 'Your JobHunter credits are running low',
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#f59e0b">Low Credits Warning</h2>
        <p>Hi ${name}, you only have <strong>${remaining} credits</strong> left this month.</p>
        <a href="${process.env.CLIENT_URL}/credits"
           style="display:inline-block;background:#2563eb;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">
          Buy Top-up
        </a>
      </div>
    `,
  }),
};

module.exports = { sendEmail, templates };