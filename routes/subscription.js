const express = require('express');
const { PrismaClient } = require('@prisma/client');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// Upgrade to Subscriber
router.post('/subscribe', authenticate, async (req, res) => {
  const { paymentMethodId } = req.body;

  if (!paymentMethodId) {
    return res.status(400).json({ error: 'Payment method is required' });
  }

  try {
    // Retrieve the authenticated user
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Create a Stripe Customer if not already exists
    if (!user.stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        payment_method: paymentMethodId,
        invoice_settings: { default_payment_method: paymentMethodId },
      });

      // Update the user with the Stripe customer ID
      await prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId: customer.id },
      });

      user.stripeCustomerId = customer.id;
    }

    // Create a subscription
    const subscription = await stripe.subscriptions.create({
      customer: user.stripeCustomerId,
      items: [{ price: process.env.STRIPE_SUB_PRICE_ID }], // Replace with your Stripe price ID
      expand: ['latest_invoice.payment_intent'],
    });

    if (subscription.status !== 'active') {
      return res.status(400).json({ error: 'Subscription failed to activate' });
    }

    // Add credits to the user and mark them as subscribed
    await prisma.user.update({
      where: { id: user.id },
      data: { isSubscribed: true, creditBalance: 50 },
    });

    // Log the credit addition in the Credits table
    await prisma.credit.create({
      data: {
        userId: user.id,
        amount: 50,
        type: 'subscription',
        stripeProductId: process.env.STRIPE_SUB_PRICE_ID,
      },
    });

    res.status(200).json({ message: 'Subscription successful', subscription });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to process subscription' });
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
