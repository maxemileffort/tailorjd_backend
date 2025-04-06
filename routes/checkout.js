const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');

let stripeKey;
if(process.env.PROD==="true"){
  stripeKey = (process.env.STRIPE_SECRET_KEY);
} else {
  stripeKey = (process.env.STRIPE_TEST_SECRET_KEY);
}

const stripe = require('stripe')(stripeKey);

const prisma = new PrismaClient();

router.post('/create-checkout-session', async (req, res) => {
  try {
    const { planId, userId, email } = req.body; // Receive email in the request

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Match planId to pricing in your database or code
    const prices = {
      standard: { 
        price: 500, 
        creditIncrement: 50, 
        name: 'Standard Plan Subscription',
        description: '50 credits / month (Renews every 30 days)',
        mode: 'subscription'
      },
      silver: { 
        price: 2500, 
        creditIncrement: 500, 
        name: 'Silver Plan Subscription',
        description: '500 credits / month (Renews every 30 days)',
        mode: 'subscription'
      },
      gold: { 
        price: 5000, 
        creditIncrement: 1500, 
        name: 'Gold Plan Subscription',
        description: '1500 credits / month (Renews every 30 days)',
        mode: 'subscription'
      },
      alacarte10: { 
        price: 1200, 
        creditIncrement: 100, 
        name: 'Credit 10 Pack',
        description: '10 credits (One time payment)',
        mode: 'payment'
      },
      alacarte50: { 
        price: 5000,
        creditIncrement: 500, 
        name: 'Credit 50 Pack',
        description: '50 credits (One time payment)',
        mode: 'payment'
      },
    };

    if (!prices[planId]) {
      return res.status(400).json({ error: 'Invalid plan ID' });
    }

    let stripeCustomerId;
    let user;

    if (userId) {
      user = await prisma.user.findUnique({
        where: { id: userId },
      });
      stripeCustomerId = user?.stripeCustomerId;

      // If user exists but doesn't have stripeCustomerId in DB, try finding/creating in Stripe
      if (user && !stripeCustomerId) {
        const existingCustomers = await stripe.customers.list({ email, limit: 1 });
        if (existingCustomers.data.length > 0) {
          // Found existing customer by email
          stripeCustomerId = existingCustomers.data[0].id;
          // Update DB record immediately
          await prisma.user.update({
            where: { id: userId },
            data: { stripeCustomerId },
          });
        } else {
          // No customer found by email, create a new one
          const customer = await stripe.customers.create({
            email,
            metadata: { userId: userId }, // Associate with user ID
          });
          stripeCustomerId = customer.id;
          // Update DB record immediately
          await prisma.user.update({
            where: { id: userId },
            data: { stripeCustomerId },
          });
        }
      }
    } else if (!userId) {
      // Handle guest checkout or case where userId is not provided
      const existingCustomers = await stripe.customers.list({ email, limit: 1 });
      if (existingCustomers.data.length > 0) {
        stripeCustomerId = existingCustomers.data[0].id;
      } else {
        // Create a new Stripe customer for guest
        const customer = await stripe.customers.create({ email });
        stripeCustomerId = customer.id;
        // Note: Cannot associate with a userId here as it's not provided
      }
    }
    // If after all checks, stripeCustomerId is still missing, something went wrong.
    if (!stripeCustomerId) {
        console.error("Failed to determine Stripe Customer ID for email:", email, "userId:", userId);
        return res.status(500).json({ error: 'Could not determine Stripe customer ID.' });
    }

    const sessionCreatePayload = {
      payment_method_types: ['card'],
      allow_promotion_codes: true,
      customer: stripeCustomerId,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: prices[planId].name,
              description: prices[planId].description,
              metadata: {
                creditIncrement: prices[planId].creditIncrement,
              },
            },
            unit_amount: prices[planId].price,
            recurring: prices[planId].mode === 'subscription' ? { interval: 'month' } : undefined,
          },
          quantity: 1,
          adjustable_quantity: prices[planId].mode === 'payment' ? { enabled: true, minimum: 1, maximum: 10 } : undefined,
        },
      ],
      mode: prices[planId].mode,
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing`,
    };

    if (prices[planId].mode === 'payment') {
      sessionCreatePayload['invoice_creation'] = { enabled: true };
    }

    const session = await stripe.checkout.sessions.create(sessionCreatePayload);

    res.status(200).json({ id: session.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});


router.get('/get-session-details', async (req, res) => {
  const { session_id } = req.query;
  
  // Validate that session_id is provided
  if (!session_id) {
    return res.status(400).json({ error: 'Missing session_id in request' });
  }
  
  try {
    // Retrieve the Stripe checkout session
    const session = await stripe.checkout.sessions.retrieve(session_id);
    
    // Use session to pull invoice information.
    const invoice = await stripe.invoices.retrieve(session.invoice);
    
    // From the invoice, pull product & customer information.
    const products = await Promise.all(invoice.lines.data.map(async (lineItem) => {
      if (lineItem.plan){
        const product = await stripe.products.retrieve(lineItem.plan.product);
        return {
          product_name: product.name,
          product_description: product.description,
          product_id: product.id,
          quantity: lineItem.quantity,
          price: lineItem.amount / 100, // Convert amount from cents to dollars
          currency: lineItem.currency
        };
      } else {
        const product = await stripe.products.retrieve(lineItem.price.product);
        return {
          product_name: product.name,
          product_description: product.description,
          product_id: product.id,
          quantity: lineItem.quantity,
          price: lineItem.amount / 100, // Convert amount from cents to dollars
          currency: lineItem.currency
        };
      }
    }));
    
    // Assign those to sessionDetails
    const sessionDetails = {
      creditIncrement: session.metadata.creditIncrement || 'Unknown Plan',
      amount_total: session.amount_total,
      currency: session.currency,
      customer_email: session.customer_details.email || 'N/A',
      products: products // Include detailed product info
    };
    
    
    // console.log(`sessionDetails: ${JSON.stringify(sessionDetails)}`);
    
    // Return session details to the client
    res.json(sessionDetails);
  } catch (error) {
    console.error('Error retrieving session details:', error);
    res.status(500).json({ error: 'Failed to retrieve session details' });
  }
});

module.exports = router;
