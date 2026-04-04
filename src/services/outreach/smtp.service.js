const nodemailer = require('nodemailer');
const logger     = require('../../config/logger');
const User       = require('../../models/User');

// Get default SMTP account for a user
const getUserSMTP = async (userId) => {
  const user = await User.findById(userId).select('+smtpAccounts');
  const accounts = user?.smtpAccounts || [];
  if (accounts.length === 0) return null;
  return accounts.find(a => a.isDefault) || accounts[0];
};

const sendOutreachEmail = async ({ userId, smtpUser, smtpPass, to, subject, body, fromName, attachments }) => {
  // If smtpUser/smtpPass not provided, load from user's default account
  let user_email = smtpUser;
  let user_pass  = smtpPass;

  if (!user_email && userId) {
    const account = await getUserSMTP(userId);
    if (!account) throw new Error('No email configured. Add your Gmail in Profile → Email Setup.');
    user_email = account.email;
    user_pass  = account.pass;
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: user_email, pass: user_pass },
  });

  const mailOptions = {
    from:    `${fromName || 'Job Applicant'} <${user_email}>`,
    to,
    subject,
    text:    body,
    html:    body.replace(/\n/g, '<br>'),
  };

  // Add attachments if provided (array of {filename, content, contentType})
  if (attachments?.length > 0) {
    mailOptions.attachments = attachments.map(a => ({
      filename:    a.filename,
      content:     a.content,   // Buffer or base64 string
      contentType: a.contentType || 'application/pdf',
    }));
  }

  const info = await transporter.sendMail(mailOptions);

  logger.info(`Outreach sent from ${user_email} to ${to}: ${info.messageId}`);
  return info;
};

module.exports = { sendOutreachEmail, getUserSMTP };