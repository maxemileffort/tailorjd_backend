const express = require('express');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const { authenticate, isAdmin } = require('../middleware/auth');
const jwt = require('jsonwebtoken');

const router = express.Router();
const prisma = new PrismaClient();

// Get demographics for the authenticated user
router.get('/demographics', authenticate, async (req, res) => {
  // console.log(req.body);
  try {
    const demographics = await prisma.demographics.findUnique({
      where: { userId: req.user.id },
    });

    if (!demographics) {
      return res.status(404).json({ error: 'Demographics not found' });
    }

    res.status(200).json(demographics);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch demographics' });
  }
});

// Get all users (admin only)
router.get('/', authenticate, isAdmin, async (req, res) => {
  try {
    const users = await prisma.user.findMany();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get a single user by ID
router.get('/:id', authenticate, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});




// Create a new user
router.post('/', async (req, res) => {
  const { email, password } = req.body; // Expect plain password, not hashed

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  // create anyone wth @tailorjd.com in email as admin
  const createAsAdmin = email.includes('@tailorjd.com');

  try {
    // Hash the password with a salt factor of 10
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    let newUser;
    if(createAsAdmin){
      const role = 'ADMIN';
      newUser = await prisma.user.create({
        data: { email, role, passwordHash: hashedPassword }, // Store hashed password
      });
    } else {
      // role defaults to 'USER'
      newUser = await prisma.user.create({
        data: { email, passwordHash: hashedPassword }, // Store hashed password
      });
    }

    // Generate a JWT token
    const token = jwt.sign(
      { id: newUser.id, email: newUser.email, role: newUser.role },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Send Email
  const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE,
    auth: {
      user: process.env.EMAIL_USER,
      pass: Buffer.from(process.env.EMAIL_PASS, 'base64').toString('utf-8'),
    },
  });

  const mailOptions = {
    to: email,
    from: "TailorJD",
    subject: 'TailorJD - First Time Login',
    text: `Hi there!\n\nThanks for signing up! To claim your free credits, all you have to do is use the email and password you signed up with to login after you get to the login page, which is here: ${process.env.FRONTEND_URL}/login \n\nEnjoy your 5 free resumes, on us! \n\nSee you in the inside. \n\n- Team TJD`,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) return res.status(500).send(error.toString());
    res.send('Password reset link sent to your email. You should receive it in the next 5-10 minutes.');
  });

    res.status(201).json({ token });
  } catch (err) {
    console.error(err);
    // if(String(err).includes('Unique constraint failed on the fields: (`email`)')){
    if (err.code === 'P2002') { // Unique constraint violation
      res.status(409).json({ error: 'Looks like that user exists already.' });  
      return;
    }
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Update demographics for the authenticated user
router.put('/demographics', authenticate, async (req, res) => {
  const { f_name, l_name, jd_target, currentIndustry, currentResume } = req.body;
  // console.log(req.body);
  try {
    const updatedDemographics = await prisma.demographics.upsert({
      where: { userId: req.user.id },
      create: {
        userId: req.user.id,
        f_name,
        l_name,
        jd_target,
        currentIndustry,
        currentResume,
      },
      update: {
        f_name,
        l_name,
        jd_target,
        currentIndustry,
        currentResume,
      },
    });

    res.status(200).json(updatedDemographics);
  } catch (err) {
    console.error('Error updating demographics:', err);
    res.status(500).json({ error: 'Failed to update demographics.' });
  }
});

// Update a user
router.put('/:id', authenticate, async (req, res) => {
  const { email, passwordHash, isSubscribed, isAdmin } = req.body;

  try {
    const updatedUser = await prisma.user.update({
      where: { id: req.params.id },
      data: { email, passwordHash, isSubscribed, isAdmin },
    });
    res.json(updatedUser);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Delete a user (admin only)
router.delete('/:id', authenticate, isAdmin, async (req, res) => {
  try {
    await prisma.user.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

module.exports = router;
