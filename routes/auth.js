const express = require('express');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// --- Google OAuth Configuration ---
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET_KEY; // Ensure this matches your .env variable name
let GOOGLE_REDIRECT_URI; 
if(process.env.PROD==="true"){
    GOOGLE_REDIRECT_URI = (process.env.GOOGLE_PROD_REDIRECT_URI);
} else {
    GOOGLE_REDIRECT_URI = (process.env.GOOGLE_TEST_REDIRECT_URI);
}

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error("Google OAuth credentials are not set in environment variables.");
  // Optionally, throw an error or disable Google routes if credentials are missing
}

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

const scopes = [
  'https://www.googleapis.com/auth/drive.readonly', // Read-only access to Drive files
  'https://www.googleapis.com/auth/userinfo.email', // Get user's email (optional, but can be useful)
  'https://www.googleapis.com/auth/userinfo.profile' // Get user's profile info (optional)
];
// --- End Google OAuth Configuration ---

// Login
router.post('/login', async (req, res) => {
  const { email, password } = req.body; // Expect plain password from the client
  
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  
  try {
    // Find the user by email
    const user = await prisma.user.findUnique({ where: { email } });
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' }); // Do not reveal if email or password is wrong
    }
    
    // console.log(user)
    
    // Compare the provided password with the hashed password in the database
    const isMatch = await bcrypt.compare(password, user.passwordHash);
    
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' }); // Avoid revealing sensitive info
    }
    
    // Generate a JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email, isAdmin: user.isAdmin, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    
    // Create Session for added layer of verification
    const session = await prisma.sessions.create({
      data: {
        userId: user.id,
        token: token,
        createdOn: new Date(),
        expiry: new Date(Date.now() + 3600000), // Token will expire in 1 hour
        isActive: true
      }
    });
    
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to login' });
  }
});

router.post('/token-check', authenticate, async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const userId = req.user.id; // Adjusted from req.user.userId
  // console.log('Token check:');
  console.log('Token:', token, 'UserID:', userId);
  
  try {
    // Find the session by token
    const session = await prisma.sessions.findUnique({
      where: { token },
    });
    
    if (!session || !session.isActive) {
      // Clear the session and log out user
      console.log('session problem');
      await prisma.sessions.update({
        where: { token },
        data: { isActive: false },
      });
      return res.status(401).json({ error: 'Session invalid. Please log in again.' });
    }
    
    // Check if token is expired
    const now = new Date();
    if (session.expiry < now) {
      // Clear the session and log out user
      console.log('session expired.');
      await prisma.sessions.update({
        where: { token },
        data: { isActive: false },
      });
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    
    // Retrieve user information, including role
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true }, // Assuming 'role' exists in your User model
    });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    
    // Refresh the token if it's close to expiry (e.g., less than 15 minutes left)
    const timeLeft = session.expiry - now;
    const fifteenMinutes = 15 * 60 * 1000;
    if (timeLeft < fifteenMinutes) {
      // Generate a new token
      const newToken = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, {
        expiresIn: '1h',
      });
      
      // Update the session with new token and expiry
      const newExpiry = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour from now
      await prisma.sessions.update({
        where: { token },
        data: {
          token: newToken,
          expiry: newExpiry,
        },
      });
      
      // Return the new token 
      return res.json({ token: newToken });
    }
    
    // Token is still good, return current 
    res.json({ token });
  } catch (err) {
    console.error('Token check error:', err);
    res.status(500).json({ error: 'Failed to check token.' });
  }
});


// Request Password Reset
router.post('/request-reset', async (req, res) => {
  const { email } = req.body;
  
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(404).send('User not found.');
  
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  
  await prisma.user.update({
    where: { id: user.id },
    data: {
      resetToken: token,
      resetTokenExpiry: new Date(Date.now() + 15 * 60 * 1000), // 15 minute expiry
    },
  });
  
  // Send Email
  let transporter;
  if (process.env.EMAIL_SERVICE === 'gmail'){
    transporter = nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE,
      auth: {
        user: process.env.EMAIL_USER,
        pass: Buffer.from(process.env.EMAIL_PASS, 'base64').toString('utf-8'),
      },
    });
  } else {
    transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: process.env.EMAIL_PORT,
      secure: true,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
  }
  const mailOptions = {
    to: email,
    from: `TailorJD <${process.env.EMAIL_USER}>`,
    subject: 'TailorJD - Password Reset',
    text: `Click this link to reset your password: ${process.env.FRONTEND_URL}/reset/${token}`,
  };
  
  transporter.sendMail(mailOptions, (error, info) => {
    if (error) return res.status(500).send(error.toString());
    res.send('Password reset link sent to your email. You should receive it in the next 5-10 minutes.');
  });
});

// Reset Password
router.post('/reset/:token', async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;
  
  // console.log('New Password:', password); // Debugging log
  
  let userId;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // console.log(`payload: ${payload}`)
    userId = payload.userId;
    // console.log(`userId: ${userId}`)
  } catch (err) {
    return res.status(400).send('Invalid or expired token.');
  }
  
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.resetToken !== token || new Date(user.resetTokenExpiry) < new Date()) {
    return res.status(400).send('Invalid or expired token.');
  }
  
  const hashedPassword = await bcrypt.hash(password, 10);
  
  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: hashedPassword,
      resetToken: null, // Clear the reset token
      resetTokenExpiry: null, // Clear the expiry
    },
  });
  
  res.send('Password has been reset successfully.');
});


// --- Google OAuth Routes ---

// NEW Route: Get the Google Auth URL (Authenticated)
router.get('/google/get-auth-url', authenticate, (req, res) => {
  // Generate the URL that asks permissions for the defined scopes
   const authorizeUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', // Request a refresh token
    scope: scopes,
    // Include user ID in state to link tokens back on callback
    state: req.user.id, // Pass the authenticated user's ID in state
    prompt: 'consent' // Force consent screen to ensure refresh token is granted, if needed
  });
  // Return the URL to the frontend
  res.json({ authorizeUrl });
});


// Callback route that Google redirects to after user consent
// This route does NOT need the 'authenticate' middleware because it relies
// on the 'code' and 'state' parameters from Google's redirect.
router.get('/google/callback', async (req, res) => {
  const { code, state: userId } = req.query; // Get code and user ID from state

  if (!code || !userId) {
    console.error('Google OAuth callback missing code or state (userId).');
    // Redirect to frontend with error
    return res.redirect(`${process.env.FRONTEND_URL}/dashboard?tab=profile&google_auth=error&message=MissingCodeOrState`);
  }

  try {
    // Exchange authorization code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    const { access_token, refresh_token, expiry_date } = tokens;

    if (!access_token) {
        console.error('Failed to retrieve access token from Google.');
        return res.redirect(`${process.env.FRONTEND_URL}/user-dashboard?tab=profile&google_auth=error&message=NoAccessToken`);
    }

    // Store tokens securely in the database associated with the user
    await prisma.user.update({
      where: { id: userId },
      data: {
        googleAccessToken: access_token,
        // Only store refresh_token if it's provided (usually only on first consent)
        ...(refresh_token && { googleRefreshToken: refresh_token }),
        googleTokenExpiry: expiry_date ? new Date(expiry_date) : null,
      },
    });

    // Redirect back to the frontend profile page with success indicator
    res.redirect(`${process.env.FRONTEND_URL}/user-dashboard?tab=profile&google_auth=success`);

  } catch (error) {
    console.error('Error exchanging Google OAuth code for tokens:', error.message);
    // Redirect to frontend with error
    res.redirect(`${process.env.FRONTEND_URL}/user-dashboard?tab=profile&google_auth=error&message=TokenExchangeFailed`);
  }
});

// NEW Route: Check if user is currently authenticated with Google
router.get('/google/status', authenticate, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: { googleAccessToken: true, googleTokenExpiry: true } // Select token and expiry
        });

        // Basic check: Does a token exist?
        // More robust check could involve expiry date or even trying a lightweight API call
        const isConnected = !!user?.googleAccessToken;
        // Optional: Check expiry (consider a buffer)
        // const isTokenValid = isConnected && (!user.googleTokenExpiry || user.googleTokenExpiry > new Date());

        res.json({ isConnected: isConnected });

    } catch (error) {
        console.error('Error checking Google auth status:', error.message);
        res.status(500).json({ error: 'Failed to check Google connection status.' });
    }
});


// --- End Google OAuth Routes ---


module.exports = router;
