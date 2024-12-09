const express = require('express');
const { PrismaClient } = require('@prisma/client');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// Upgrade to Subscriber
router.post('/subscribe', authenticate, async (req, res) => {
  const { userEmail } = req.body;

  try {
    // change user to isSubscribed = true
    const user = await prisma.user.upsert({
      where: { email: userEmail },
      update: {
        isSubscribed: true,
      },
      create: {
        email: userEmail,
        isSubscribed: true,
      },
    });

    res.status(200).json(user);
  } catch (err) {
    res.status(500).json(err);
  }

});

// Cancel Subscription
router.post('/cancel', authenticate, async (req, res) => {
    try {
      // Retrieve the authenticated user
      const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  
      if (!user || !user.stripeCustomerId) {
        return res.status(404).json({ error: 'User or subscription not found' });
      }
  
      // Fetch the user's subscription in Stripe
      const subscriptions = await stripe.subscriptions.list({
        customer: user.stripeCustomerId,
        status: 'active',
        limit: 1,
      });
  
      if (subscriptions.data.length === 0) {
        return res.status(400).json({ error: 'No active subscription found' });
      }
  
      const subscription = subscriptions.data[0];
  
      // Cancel the subscription in Stripe
      await stripe.subscriptions.del(subscription.id);
  
      // Update the user record to mark them as unsubscribed
      await prisma.user.update({
        where: { id: user.id },
        data: { isSubscribed: false },
      });
  
      res.status(200).json({ message: 'Subscription canceled successfully' });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to cancel subscription' });
    }
  });
  

module.exports = router;
