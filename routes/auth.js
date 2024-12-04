const express = require('express');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');

const router = express.Router();
const prisma = new PrismaClient();

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

    // Compare the provided password with the hashed password in the database
    const isMatch = await bcrypt.compare(password, user.passwordHash);

    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' }); // Avoid revealing sensitive info
    }

    // Generate a JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email, isAdmin: user.isAdmin },
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
  const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  const mailOptions = {
    to: email,
    from: "TailorJD",
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

module.exports = router;
