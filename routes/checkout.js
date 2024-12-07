const express = require('express');
const router = express.Router();

let stripeKey;
if(process.env.PROD==="true"){
  stripeKey = (process.env.STRIPE_SECRET_KEY);
} else {
  stripeKey = (process.env.STRIPE_TEST_SECRET_KEY);
}

const stripe = require('stripe')(stripeKey);

router.post('/create-checkout-session', async (req, res) => {
  try {
    const { planId } = req.body; // Receive the plan identifier from the frontend
    
    // Match planId to pricing in your database or code
    const prices = {
      standard: { 
        price: 500, 
        description: 'Standard Plan - 5 credits / month',
        mode: 'subscription'
     },
      silver: { 
        price: 2500, 
        description: 'Silver Plan - 50 credits / month',
        mode: 'subscription'
     },
      gold: { 
        price: 5000, 
        description: 'Gold Plan - 150 credits / month',
        mode: 'subscription'
     },
      alacarte10: { 
        price: 1200, 
        description: 'A La Carte - 10 credits (One time payment)',
        mode: 'payment'
     },
      alacarte50: { 
        price: 5000, 
        description: 'A La Carte - 50 credits (One time payment)',
        mode: 'payment'
     },
    };

    if (!prices[planId]) {
      return res.status(400).json({ error: 'Invalid plan ID' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: prices[planId].description,
            },
            unit_amount: prices[planId].price,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/cancel`,
    });

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

    // Retrieve additional information (like customer, if needed)
    const customer = await stripe.customers.retrieve(session.customer);

    // Construct response data
    const sessionDetails = {
      plan_name: session.metadata.plan_name || 'Unknown Plan',
      amount_total: session.amount_total,
      currency: session.currency,
      customer_email: customer.email || 'N/A',
    };

    console.log(sessionDetails);

    // Return session details to the client
    res.json(sessionDetails);
  } catch (error) {
    console.error('Error retrieving session details:', error);
    res.status(500).json({ error: 'Failed to retrieve session details' });
  }
});

module.exports = router;
