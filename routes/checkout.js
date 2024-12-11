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
        creditIncrement: 5, 
        name: 'Standard Plan Subscription',
        description: '5 credits / month (Renews every 30 days)',
        mode: 'subscription'
     },
      silver: { 
        price: 2500, 
        creditIncrement: 50, 
        name: 'Silver Plan Subscription',
        description: '50 credits / month (Renews every 30 days)',
        mode: 'subscription'
     },
      gold: { 
        price: 5000, 
        creditIncrement: 150, 
        name: 'Gold Plan Subscription',
        description: '150 credits / month (Renews every 30 days)',
        mode: 'subscription'
     },
      alacarte10: { 
        price: 1200, 
        creditIncrement: 10, 
        name: 'Credit 10 Pack',
        description: '10 credits (One time payment)',
        mode: 'payment'
     },
      alacarte50: { 
        price: 5000,
        creditIncrement: 50, 
        name: 'Credit 50 Pack',
        description: '50 credits (One time payment)',
        mode: 'payment'
     },
    };

    if (!prices[planId]) {
      return res.status(400).json({ error: 'Invalid plan ID' });
    }

    const sessionCreatePaylod = {
      payment_method_types: ['card'],
      allow_promotion_codes: true,
      
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: prices[planId].name,
              description: prices[planId].description,
              metadata : {
                creditIncrement : prices[planId].creditIncrement
              },
            },
            unit_amount: prices[planId].price,
            recurring: prices[planId].mode === 'subscription' ? { interval: 'month' } : undefined, // Add recurring for subscriptions
          },
          quantity: 1,
          adjustable_quantity: prices[planId].mode === 'payment' ? { enabled: true, minimum: 1, maximum: 10 } : undefined, // Enable adjustable quantity for one-time payments
        },
      ],
      mode: prices[planId].mode, // Ensure this matches either 'payment' or 'subscription'
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing`,
    }

    if (prices[planId].mode === 'payment'){
      // Subs auto invoice, while payments don't. We depend on the invoice
      // to correctly increment credits, so this MUST be attached when 
      // possible.
      sessionCreatePaylod['invoice_creation'] = { enabled: true }
    }

    const session = await stripe.checkout.sessions.create(sessionCreatePaylod);
    
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
