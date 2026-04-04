const passport = require('passport');
const logger   = require('./logger');

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
  const User        = require('../models/User');
  const UserCredits = require('../models/UserCredits');
  const { PLAN_CREDITS } = require('../utils/constants');

  passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  `${process.env.API_URL || 'http://localhost:5000'}/api/v1/auth/google/callback`,
  }, async (_accessToken, _refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value;
      if (!email) return done(new Error('No email from Google'), null);

      let user = await User.findOne({ $or: [{ googleId: profile.id }, { email }] });

      if (user) {
        if (!user.googleId) {
          user.googleId = profile.id;
          await user.save();
        }
      } else {
        user = await User.create({
          googleId:      profile.id,
          email,
          profile: {
            firstName:     profile.name?.givenName  || '',
            lastName:      profile.name?.familyName || '',
            avatarUrl:     profile.photos?.[0]?.value || '',
            completionPct: 20,
          },
          emailVerified: true,
          status:        'active',
          plan:          'free',
        });

        await UserCredits.create({
          userId:       user._id,
          plan:         'free',
          totalCredits: PLAN_CREDITS.free,
        });

        logger.info(`New Google OAuth user: ${email}`);
      }

      return done(null, user);
    } catch (err) {
      logger.error('Google OAuth strategy error:', err.message);
      return done(err, null);
    }
  }));

  logger.info('Google OAuth strategy registered');
} else {
  logger.warn('Google OAuth not configured — GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET missing');
}

module.exports = passport;