require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const User = require('../models/User');

async function verify() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  const user = await User.findOneAndUpdate(
    { email: 'test@gmail.com' },
    { 
      emailVerified: true, 
      status: 'active',
      emailVerifyToken: undefined,
      emailVerifyExpires: undefined
    },
    { new: true }
  );
  
  console.log('User verified:', user.email, '| Status:', user.status, '| Verified:', user.emailVerified);
  await mongoose.disconnect();
}

verify().catch(console.error);