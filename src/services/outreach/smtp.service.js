const nodemailer  = require('nodemailer');
const { google }  = require('googleapis');
const logger      = require('../../config/logger');
const User        = require('../../models/User');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL    || 'yash51217@gmail.com';
const ADMIN_PASS  = process.env.ADMIN_EMAIL_PASS || process.env.SMTP_PASS || '';

// ── Get user's legacy SMTP account ───────────────────────────────
const getUserSMTP = async (userId) => {
  const user = await User.findById(userId).select('+smtpAccounts');
  const accounts = user?.smtpAccounts || [];
  if (accounts.length === 0) return null;
  return accounts.find(a => a.isDefault) || accounts[0];
};

// ── Get fresh Gmail OAuth access token ───────────────────────────
const getGmailAccessToken = async (userId) => {
  const user = await User.findById(userId)
    .select('+gmailAccessToken +gmailRefreshToken +gmailEmail');

  if (!user?.gmailRefreshToken) return null;

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  oauth2Client.setCredentials({
    access_token:  user.gmailAccessToken,
    refresh_token: user.gmailRefreshToken,
  });

  try {
    const { token } = await oauth2Client.getAccessToken();
    const fresh = token || user.gmailAccessToken;

    // Persist refreshed token
    if (token && token !== user.gmailAccessToken) {
      await User.findByIdAndUpdate(userId, { gmailAccessToken: token });
    }

    return { accessToken: fresh, email: user.gmailEmail };
  } catch (err) {
    logger.warn(`Gmail token refresh failed for ${userId}: ${err.message}`);
    return null;
  }
};

// ── Send via Gmail API (OAuth) ────────────────────────────────────
const sendViaGmailAPI = async ({ accessToken, fromEmail, fromName, to, subject, body, attachments }) => {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  const gmail = google.gmail({ version: 'v1', auth });

  // Build RFC 2822 raw message
  const boundary  = `boundary_${Date.now()}`;
  const hasAttach = attachments?.length > 0;

  let raw = [
    `From: ${fromName || 'Job Applicant'} <${fromEmail}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    hasAttach
      ? `Content-Type: multipart/mixed; boundary="${boundary}"`
      : 'Content-Type: text/html; charset=UTF-8',
    '',
  ].join('\r\n');

  if (hasAttach) {
    // HTML body part
    raw += [
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      '',
      body.replace(/\n/g, '<br>'),
      '',
    ].join('\r\n');

    // Attachment parts
    for (const a of attachments) {
      const b64 = Buffer.isBuffer(a.content)
        ? a.content.toString('base64')
        : a.content;
      raw += [
        `--${boundary}`,
        `Content-Type: ${a.contentType || 'application/pdf'}`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${a.filename}"`,
        '',
        b64,
        '',
      ].join('\r\n');
    }
    raw += `--${boundary}--`;
  } else {
    raw += body.replace(/\n/g, '<br>');
  }

  const encoded = Buffer.from(raw).toString('base64url');

  const result = await gmail.users.messages.send({
    userId:      'me',
    requestBody: { raw: encoded },
  });

  logger.info(`Outreach sent via Gmail API from ${fromEmail} to ${to}: ${result.data.id}`);
  return { messageId: result.data.id, method: 'gmail_api' };
};

// ── Send via nodemailer SMTP (legacy app password) ────────────────
const sendViaSMTP = async ({ smtpUser, smtpPass, fromName, to, subject, body, attachments }) => {
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: smtpUser, pass: smtpPass },
  });

  const mailOptions = {
    from:    `${fromName || 'Job Applicant'} <${smtpUser}>`,
    to, subject,
    text:    body,
    html:    body.replace(/\n/g, '<br>'),
  };

  if (attachments?.length > 0) {
    mailOptions.attachments = attachments.map(a => ({
      filename:    a.filename,
      content:     a.content,
      contentType: a.contentType || 'application/pdf',
    }));
  }

  const info = await transporter.sendMail(mailOptions);
  logger.info(`Outreach sent via SMTP from ${smtpUser} to ${to}: ${info.messageId}`);
  return { messageId: info.messageId, method: 'smtp' };
};

// ── Main send function ────────────────────────────────────────────
// Priority: Gmail OAuth > Legacy SMTP > Admin fallback
const sendOutreachEmail = async ({
  userId, smtpUser, smtpPass,
  to, subject, body, fromName, attachments,
  useAdminFallback = false,
}) => {

  // 1. Try Gmail OAuth (best option — no app password needed)
  if (userId) {
    const gmail = await getGmailAccessToken(userId);
    if (gmail) {
      return sendViaGmailAPI({
        accessToken: gmail.accessToken,
        fromEmail:   gmail.email,
        fromName, to, subject, body, attachments,
      });
    }
  }

  // 2. Try explicit smtpUser/smtpPass passed in
  if (smtpUser && smtpPass) {
    return sendViaSMTP({ smtpUser, smtpPass, fromName, to, subject, body, attachments });
  }

  // 3. Try user's saved SMTP accounts
  if (userId) {
    const account = await getUserSMTP(userId);
    if (account) {
      return sendViaSMTP({
        smtpUser: account.email, smtpPass: account.pass,
        fromName, to, subject, body, attachments,
      });
    }
  }

  // 4. Admin fallback (platform email)
  if (useAdminFallback && ADMIN_PASS) {
    logger.info(`Using admin email fallback (${ADMIN_EMAIL}) for user ${userId}`);
    return sendViaSMTP({
      smtpUser: ADMIN_EMAIL, smtpPass: ADMIN_PASS,
      fromName, to, subject, body, attachments,
    });
  }

  throw new Error('No email configured. Connect your Gmail in Profile → Email Setup.');
};

module.exports = { sendOutreachEmail, getUserSMTP, getGmailAccessToken };
