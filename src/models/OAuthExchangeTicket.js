const mongoose = require('mongoose');

/**
 * One-time Google OAuth handoff: avoids putting JWTs in the browser URL.
 * Documents auto-delete ~5 minutes after creation (TTL index).
 */
const oauthExchangeTicketSchema = new mongoose.Schema(
  {
    code:   { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

oauthExchangeTicketSchema.index({ createdAt: 1 }, { expireAfterSeconds: 300 });

module.exports = mongoose.model('OAuthExchangeTicket', oauthExchangeTicketSchema);
