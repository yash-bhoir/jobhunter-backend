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

  jobAlert: (name, jobs, role, clientUrl) => {
    const jobRows = jobs.slice(0, 10).map(j => `
      <tr style="border-bottom:1px solid #f1f5f9">
        <td style="padding:12px 8px">
          <p style="margin:0;font-weight:600;color:#1e293b;font-size:14px">${j.title}</p>
          <p style="margin:4px 0 0;color:#64748b;font-size:13px">${j.company}${j.location ? ` · ${j.location}` : ''}${j.remote ? ' · Remote' : ''}</p>
          ${j.matchScore > 0 ? `<p style="margin:4px 0 0;color:#2563eb;font-size:12px;font-weight:600">${j.matchScore}% match</p>` : ''}
        </td>
        <td style="padding:12px 8px;text-align:right;vertical-align:top">
          ${j.url ? `<a href="${j.url}" style="background:#2563eb;color:white;padding:6px 14px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600;white-space:nowrap">View Job</a>` : ''}
        </td>
      </tr>
    `).join('');

    return {
      subject: `🔔 ${jobs.length} new ${role} jobs found for you`,
      html: `
        <div style="font-family:sans-serif;max-width:620px;margin:0 auto;padding:24px;background:#f8fafc">
          <div style="background:white;border-radius:16px;padding:32px;box-shadow:0 1px 8px rgba(0,0,0,0.06)">
            <div style="text-align:center;margin-bottom:24px">
              <div style="width:48px;height:48px;background:#2563eb;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px">
                <span style="color:white;font-size:24px">💼</span>
              </div>
              <h1 style="margin:0;font-size:22px;font-weight:800;color:#1e293b">New Jobs Found!</h1>
              <p style="margin:8px 0 0;color:#64748b;font-size:14px">Hi ${name}, we found <strong>${jobs.length} new ${role} jobs</strong> matching your profile</p>
            </div>
            <table style="width:100%;border-collapse:collapse">
              ${jobRows}
            </table>
            <div style="text-align:center;margin-top:24px">
              <a href="${clientUrl}/linkedin" style="display:inline-block;background:#2563eb;color:white;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px">View All Jobs →</a>
            </div>
            <p style="color:#94a3b8;font-size:12px;text-align:center;margin-top:20px">
              You're receiving this because LinkedIn job alerts are enabled.<br>
              <a href="${clientUrl}/linkedin" style="color:#2563eb">Manage alert settings</a>
            </p>
          </div>
        </div>
      `,
    };
  },

  dreamCompanyAlert: (name, jobs, clientUrl) => {
    const jobRows = jobs.slice(0, 15).map(j => `
      <tr style="border-bottom:1px solid #f1f5f9">
        <td style="padding:12px 8px">
          <p style="margin:0;font-weight:600;color:#1e293b;font-size:14px">${j.title}</p>
          <p style="margin:4px 0 0;color:#64748b;font-size:13px">${j.company}${j.location ? ` · ${j.location}` : ''}${j.remote ? ' · Remote' : ''}</p>
        </td>
        <td style="padding:12px 8px;text-align:right;vertical-align:top">
          ${j.url ? `<a href="${j.url}" style="background:#7c3aed;color:white;padding:6px 14px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600;white-space:nowrap">View</a>` : ''}
        </td>
      </tr>
    `).join('');

    return {
      subject: `⭐ ${jobs.length} new opening(s) at your watched companies`,
      html: `
        <div style="font-family:sans-serif;max-width:620px;margin:0 auto;padding:24px;background:#f8fafc">
          <div style="background:white;border-radius:16px;padding:32px;box-shadow:0 1px 8px rgba(0,0,0,0.06)">
            <div style="text-align:center;margin-bottom:24px">
              <div style="width:48px;height:48px;background:#7c3aed;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px">
                <span style="color:white;font-size:24px">⭐</span>
              </div>
              <h1 style="margin:0;font-size:22px;font-weight:800;color:#1e293b">Dream company openings</h1>
              <p style="margin:8px 0 0;color:#64748b;font-size:14px">Hi ${name}, new roles appeared on career boards you follow.</p>
            </div>
            <table style="width:100%;border-collapse:collapse">${jobRows}</table>
            <div style="text-align:center;margin-top:24px">
              <a href="${clientUrl}/career-scanner" style="display:inline-block;background:#7c3aed;color:white;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px">Open Career Pages →</a>
            </div>
            <p style="color:#94a3b8;font-size:12px;text-align:center;margin-top:20px">
              Manage watched companies on Career Pages.<br/>
              <a href="${clientUrl}/career-scanner" style="color:#7c3aed">Edit list</a>
            </p>
          </div>
        </div>
      `,
    };
  },

  adminOtp: (name, otp) => ({
    subject: 'JobHunter Admin — Your login verification code',
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f8fafc">
        <div style="background:white;border-radius:16px;padding:32px;box-shadow:0 1px 8px rgba(0,0,0,0.06)">
          <div style="text-align:center;margin-bottom:28px">
            <div style="width:52px;height:52px;background:#1e40af;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:14px">
              <span style="color:white;font-size:26px">🔐</span>
            </div>
            <h1 style="margin:0;font-size:22px;font-weight:800;color:#1e293b">Admin Login Verification</h1>
            <p style="margin:8px 0 0;color:#64748b;font-size:14px">Hi ${name}, use the code below to complete your login</p>
          </div>

          <div style="background:#f1f5f9;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
            <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#64748b;letter-spacing:1px;text-transform:uppercase">Verification Code</p>
            <p style="margin:0;font-size:42px;font-weight:800;color:#1e40af;letter-spacing:10px">${otp}</p>
          </div>

          <p style="color:#64748b;font-size:13px;text-align:center;margin:0">
            This code expires in <strong>10 minutes</strong>.<br>
            If you did not attempt to log in, your password may be compromised — change it immediately.
          </p>
        </div>
        <p style="color:#94a3b8;font-size:11px;text-align:center;margin-top:16px">
          JobHunter Admin Portal · Do not share this code with anyone
        </p>
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

  errorAlert: ({ method, endpoint, statusCode, errorCode, message, stack, userId, userEmail, ip, userAgent, timestamp }) => ({
    subject: `🚨 [${statusCode}] ${method} ${endpoint} — JobHunter Error`,
    html: `
      <div style="font-family:monospace;max-width:700px;margin:0 auto;padding:20px;background:#0f172a;color:#e2e8f0;border-radius:8px">
        <div style="background:#ef4444;color:white;padding:10px 16px;border-radius:6px;margin-bottom:16px">
          <strong style="font-size:16px">⚠ Server Error — ${statusCode} ${errorCode}</strong>
        </div>

        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr><td style="color:#94a3b8;padding:4px 8px;width:130px">Time</td>       <td style="color:#f1f5f9;padding:4px 8px">${timestamp}</td></tr>
          <tr><td style="color:#94a3b8;padding:4px 8px">Endpoint</td>   <td style="color:#f1f5f9;padding:4px 8px"><strong>${method}</strong> ${endpoint}</td></tr>
          <tr><td style="color:#94a3b8;padding:4px 8px">Status</td>     <td style="color:#fca5a5;padding:4px 8px">${statusCode} — ${errorCode}</td></tr>
          <tr><td style="color:#94a3b8;padding:4px 8px">Message</td>    <td style="color:#fbbf24;padding:4px 8px">${message}</td></tr>
          <tr><td style="color:#94a3b8;padding:4px 8px">User ID</td>    <td style="color:#f1f5f9;padding:4px 8px">${userId || '—'}</td></tr>
          <tr><td style="color:#94a3b8;padding:4px 8px">User Email</td> <td style="color:#f1f5f9;padding:4px 8px">${userEmail || '—'}</td></tr>
          <tr><td style="color:#94a3b8;padding:4px 8px">IP</td>         <td style="color:#f1f5f9;padding:4px 8px">${ip || '—'}</td></tr>
          <tr><td style="color:#94a3b8;padding:4px 8px">User Agent</td> <td style="color:#94a3b8;padding:4px 8px;font-size:11px">${userAgent || '—'}</td></tr>
        </table>

        ${stack ? `
        <div style="margin-top:16px">
          <div style="color:#94a3b8;font-size:11px;margin-bottom:6px;text-transform:uppercase;letter-spacing:1px">Stack Trace</div>
          <pre style="background:#1e293b;color:#f87171;padding:12px;border-radius:6px;font-size:11px;overflow:auto;white-space:pre-wrap;word-break:break-all;margin:0">${stack.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
        </div>` : ''}

        <div style="margin-top:16px;padding-top:12px;border-top:1px solid #1e293b;font-size:11px;color:#475569;text-align:center">
          JobHunter Error Monitor · ${new Date().getFullYear()}
        </div>
      </div>
    `,
  }),
};

module.exports = { sendEmail, templates };