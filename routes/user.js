const express = require('express');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const { authenticate, isAdmin } = require('../middleware/auth');
const { createPortalSession } = require('../services/billingHelpers');
const jwt = require('jsonwebtoken');

const router = express.Router();
const prisma = new PrismaClient();

let stripeKey;
if(process.env.PROD==="true"){
  stripeKey = (process.env.STRIPE_SECRET_KEY);
} else {
  stripeKey = (process.env.STRIPE_TEST_SECRET_KEY);
}

const stripe = require('stripe')(stripeKey);

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

router.get("/billing", authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    // Handled by authenticate middleware
    // if (!userId) {
    //   return res.status(400).json({ error: 'Invalid parameters: userId must be defined.' });
    // }

    // const userData = await prisma.user.findUnique({
    //   where: { id: userId },
    // });

    // Handle potential database errors separately
    let userData;
    try {
      userData = await prisma.user.findUnique({ where: { id: userId } });
    } catch (error) {
      console.error('Database error:', error);
      return res.status(500).json({ error: 'Internal server error.' });
    }

    if (!userData) {
      console.log('Unable to find user.');
      return res.status(400).json({ error: 'Unable to find user.' });
    }

    let stripeId = userData.stripeCustomerId;

    // Check if Stripe ID exists
    if (!stripeId) {
      console.log('No Stripe ID found for user, creating one...');
      try {
        // Create a new Stripe customer
        const customer = await stripe.customers.create({
          email: userData.email, // Assuming you have user's email
        });

        // Save the newly created Stripe ID in your database
        await prisma.user.update({
          where: { id: userId },
          data: { stripeCustomerId: customer.id },
        });

        stripeId = customer.id; // Update with the newly created Stripe ID
      } catch (error) {
        console.error('Error creating Stripe customer:', error);
        return res.status(500).json({ error: 'Failed to create Stripe customer.' });
      }
    }

    try {
      const portalUrl = await createPortalSession(stripeId);
      return res.status(200).json({ portalUrl });
    } catch (error) {
      console.error(`Error creating billing portal session for stripeCustomerId ${stripeId}:`, error);
      return res.status(500).json({ error: 'Error creating billing portal session.' });
    }
    
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'An unexpected error occurred.' });
  }
});

// Get all users (admin only)
router.get('/writers', authenticate, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: {
        role: {
          in: ['ADMIN', 'WRITER'],
        },
      },
    });
    
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
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

  // Assign stripe customer ID at signup in order to make upgrades easier
  const customer = await stripe.customers.create({
    email,
    metadata: {
      accountType: 'free',   // Track the account type
    },
  });

  const stripeCustomerId = customer.id;
  
  try {
    // Hash the password with a salt factor of 10
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    
    let role;
    if(createAsAdmin){
      role = 'ADMIN';
    } else {
      // role defaults to 'USER'
      role = 'USER';
    }

    const newUser = await prisma.user.create({
      data: { email, role, stripeCustomerId, passwordHash: hashedPassword }, // Store hashed password
    });
    
    // Generate a JWT token
    const token = jwt.sign(
      { id: newUser.id, email: newUser.email, role: newUser.role },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    
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
      subject: 'TailorJD - First Time Login',
      text: `Hi there!\n\nThanks for signing up! To claim your free credits, all you have to do is use the email and password you signed up with to login after you get to the login page, which is here: ${process.env.FRONTEND_URL}/login \n\nEnjoy your 5 free resumes, on us! \n\nSee you in the inside. \n\n- Team TJD`,
    };
    
    transporter.sendMail(mailOptions, (error, info) => {
      if (error) return res.status(500).send(error.toString());
      res.send(`Confirmation email sent to ${email}. You should receive it in the next 5-10 minutes.`);
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

// Update a user
router.put('/:id/role', authenticate, async (req, res) => {
  const { role } = req.body;
  
  try {
    const updatedUser = await prisma.user.update({
      where: { id: req.params.id },
      data: { role },
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
