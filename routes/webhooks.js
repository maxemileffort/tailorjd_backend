const express = require('express');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const { PrismaClient } = require('@prisma/client');
const { updateUserCredits } = require('../services/credits');
const { updateCustId } = require('../services/billingHelpers')

let stripeKey, endpointSecret;
if(process.env.PROD==="true"){
  stripeKey = (process.env.STRIPE_SECRET_KEY);
  endpointSecret = (process.env.STRIPE_WEBHOOK_SECRET);
} else {
  stripeKey = (process.env.STRIPE_TEST_SECRET_KEY);
  endpointSecret = (process.env.STRIPE_TEST_WEBHOOK_SECRET);
}

const stripe = require('stripe')(stripeKey);

const router = express.Router();
const prisma = new PrismaClient();

// Helper function to find user by Stripe data, prioritizing Stripe Customer ID
async function findUserByStripeData(stripeCustomerId, customerEmail) {
  let user = null;

  // 1. Try finding user by Stripe Customer ID
  if (stripeCustomerId) {
    user = await prisma.user.findFirst({
      where: { stripeCustomerId: stripeCustomerId },
    });
  }

  // 2. If not found by Stripe ID, try finding by email
  if (!user && customerEmail) {
    user = await prisma.user.findUnique({
      where: { email: customerEmail },
    });
    // If found by email, ensure their Stripe Customer ID is updated in DB
    if (user && stripeCustomerId && user.stripeCustomerId !== stripeCustomerId) {
      console.log(`Updating Stripe Customer ID for user ${user.id} found by email.`);
      try {
        await updateCustId(user.id, stripeCustomerId);
        // Re-fetch user data to ensure consistency, though updateCustId might return it
        user = await prisma.user.findUnique({ where: { id: user.id } });
      } catch (error) {
         console.error(`Error updating stripeCustomerId for user ${user.id} found by email:`, error);
         // Decide if this error should prevent further processing
      }
    }
  }
  return user;
}


router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  
  let event;
  
  try {
    // Verify the webhook signature
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  // Handle the event
  switch (event.type) {
    case 'charge.succeeded':
    // Allocate credits for successful one-time or initial subscription purchases
    await handleChargeSucceeded(event.data.object);
    break;
    case 'checkout.session.completed':
    // Allocate credits for successful one-time or initial subscription purchases
    await handleCheckoutSessionCompleted(event.data.object);
    break;
    case 'invoice.payment_succeeded':
    // Allocate credits for recurring subscription renewals
    await handlePaymentSucceeded(event.data.object);
    break;
    case 'invoice.payment_failed':
    await handlePaymentFailed(event.data.object);
    break;
    default:
    console.log(`Unhandled event type ${event.type}`);
  }
  
  // Acknowledge receipt of the event
  res.status(200).send('Received');
});

// Event Handlers
async function handleChargeSucceeded(charge) {
  
  const stripeCustomerId = charge.customer;
  const invoice = await stripe.invoices.retrieve(charge.invoice); // Still need invoice for details & email
  const customerEmail = invoice.customer_email;

  try {
    let user = await findUserByStripeData(stripeCustomerId, customerEmail);

    // If user still not found after lookup, create a new one
    if (!user && customerEmail && stripeCustomerId) {
      console.log('User not found by Stripe ID or email. Creating new user for email:', customerEmail);
      const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD
      // Hash the default password
      const hashedPassword = await bcrypt.hash(DEFAULT_PASSWORD, 10);
      // Create a new user with the email from the invoice
      user = await prisma.user.create({
        data: {
          email: invoice.customer_email,
          passwordHash : hashedPassword,
          stripeCustomerId : invoice.customer,
          // Add any additional user data here, e.g., username or other required fields
        },
      });
      
      console.log(`New user created with email: ${invoice.customer_email}`);
      
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
        to: invoice.customer_email,
        from: `TailorJD <${process.env.EMAIL_USER}>`,
        subject: 'TailorJD - New Account Info',
        text: `Hi! \n\nThanks for your purchase. 
        \nYour credits are tied to the email that was used during checkout, 
        \nand we couldn't find that email in our user database. 
        \nHere is your new account information:
        \n\nEmail: ${invoice.customer_email}
        \nPassword: ${DEFAULT_PASSWORD}
        \n\nLogin here: https://tailorjd.com/login
        \n\nThanks again!
        \n- Team TJD
        \n\n\nQuestions? Drop us a message here: https://tailorjd.com/contact`,
      };
      
      transporter.sendMail(mailOptions, (error, info) => {
        if (error) return res.status(500).send(error.toString());
      });
      
      // Log the event in the ActivityLog table
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'User created through purchase workflow',
        },
      });
    }
    
    const products = await Promise.all(invoice.lines.data.map(async (lineItem) => {
      
      const product = await stripe.products.retrieve(lineItem.price.product);
      return {
        product_name: product.name,
        product_description: product.description,
        product_id: product.id,
        quantity: lineItem.quantity,
        creditIncrement: product.metadata.creditIncrement,
        price: lineItem.amount / 100, // Convert amount from cents to dollars
        currency: lineItem.currency
      };
    }));
    
    // Assign those to invoiceDetails
    const invoiceDetails = {
      creditIncrement: products[0].metadata.creditIncrement || 50, // at least 50, in case it doesn't pick up from meta data.
      amount_total: invoice.amount_paid,
      currency: invoice.currency,
      customer_email: invoice.customer_email || 'N/A',
      products: products // Include detailed product info
    };
    
    // give them their credits and make sure their id exists in our database
    const amount = invoiceDetails.products[0].creditIncrement;
    const qty = invoiceDetails.products[0].quantity;
    const finalAmt = amount * qty;
    await updateUserCredits(user.id, finalAmt, 'increment');
    await updateCustId(user.id, invoice.customer);
    
    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: `User purchased ${invoiceDetails.products[0].product_name}`,
        details: JSON.stringify(invoiceDetails)
      },
    });
    
  } catch (err) {
    console.error('Failed to process payment succeeded event:', err.message);
    
    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: `Error with invoice ID ${charge.invoice}`,
        activityType: 'ERROR',
        details: JSON.stringify(charge)
      },
    });
  }
}

async function handleCheckoutSessionCompleted(session) {
  console.log('Checkout session completed:', session.id);
  
  let user;
  
  // Retrieve the Stripe checkout session
  // const session = await stripe.checkout.sessions.retrieve(session.id);
  
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
  const stripeCustomerId = session.customer;
  const customerEmail = session.customer_details?.email;

  try {
    const user = await findUserByStripeData(stripeCustomerId, customerEmail);

    // Ensure user is found before proceeding
    if (!user) {
      console.error(`User not found for checkout session ${session.id} (Customer ID: ${stripeCustomerId}, Email: ${customerEmail})`);
      // Log error and exit or handle as appropriate (e.g., maybe create user if it's a first-time purchase scenario not caught elsewhere)
       await prisma.activityLog.create({
         data: {
           action: 'Checkout Session - Error: User Not Found',
           activityType: 'ERROR',
           details: { sessionId: session.id, customerId: stripeCustomerId, email: customerEmail },
         },
       });
      return; // Exit if user cannot be identified
    }

    // Credits are usually handled by charge.succeeded or invoice.payment_succeeded
    // This handler might just be for logging or specific post-checkout actions.
    // TODO: Confirm if the credit add is being double counted.
    // const amount = sessionDetails.creditIncrement; // Check if credit logic is needed here
    // const qty = sessionDetails.products[0].quantity;
    // const finalAmt = amount * qty; // Commented out as amount and qty are commented out, and credit update logic is likely handled elsewhere.
    // await updateUserCredits(user.id, finalAmt, 'increment');
    await updateCustId(user.id, invoice.customer);
    
    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: `New Checkout Session`,
        activityType: 'LOG',
        details: { 
          session:JSON.stringify(session), 
          details:JSON.stringify(sessionDetails),
        }
      },
    });
    
  } catch (err) {
    console.error('Failed to log checkout session completed event:', err.message);
    // Log the error in the ActivityLog table
    await prisma.activityLog.create({
      data: {
        action: 'Checkout Session - Error',
        activityType: 'ERROR',
        details: {
          error: err.message,
          sessionId: session.id,
          customerId: session.customer,
        },
      },
    });
  }
}

async function handlePaymentSucceeded(invoice) {
  
  const stripeCustomerId = invoice.customer;
  const customerEmail = invoice.customer_email;

  try {
    const user = await findUserByStripeData(stripeCustomerId, customerEmail);

     // Ensure user is found before proceeding
    if (!user) {
      console.error(`User not found for invoice ${invoice.id} (Customer ID: ${stripeCustomerId}, Email: ${customerEmail})`);
       await prisma.activityLog.create({
         data: {
           action: 'Payment Success - Error: User Not Found',
           activityType: 'ERROR',
           details: { invoiceId: invoice.id, customerId: stripeCustomerId, email: customerEmail },
         },
       });
      return; // Exit if user cannot be identified
    }
    
    const products = await Promise.all(invoice.lines.data.map(async (lineItem) => {
      
      const product = await stripe.products.retrieve(lineItem.price.product);
      return {
        product_name: product.name,
        product_description: product.description,
        product_id: product.id,
        quantity: lineItem.quantity,
        creditIncrement: product.metadata.creditIncrement,
        price: lineItem.amount / 100, // Convert amount from cents to dollars
        currency: lineItem.currency
      };
    }));
    
    // Assign those to sessionDetails
    const invoiceDetails = {
      creditIncrement: products[0].creditIncrement || 'Unknown Plan',
      amount_total: invoice.amount_paid,
      qty: products[0].quantity,
      currency: products[0].currency,
      customer_email: invoice.customer_email || 'N/A',
      products: products // Include detailed product info
    };
    
    // if there is a 100% off coupon applied, users won't get their credits.
    // this handles that situation.
    const amount = invoiceDetails.creditIncrement;
    const qty = invoiceDetails.qty;
    const finalAmt = amount * qty;
    
    await updateCustId(user.id, invoice.customer);
    
    console.log(`finalAmt: ${finalAmt}`);
    console.log(`invoiceDetails: ${JSON.stringify(invoiceDetails)}`);
    
    if (!invoice.charge){
      console.log('100% off coupon applied. Updating credits. -MW')
      await updateUserCredits(user.id, finalAmt, 'increment');
    }
    
    
    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: `Payment Success`,
        activityType: 'LOG',
        details: { 
          session:JSON.stringify(invoice), 
          details:JSON.stringify(invoiceDetails),
        }
      },
    });
    
  } catch (err) {
    console.error('Failed to process payment succeeded event:', err.message);
    
    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: `Payment Success`,
        activityType: 'LOG',
        details: { 
          err, 
          invoice,
        }
      },
    });
  }
}

async function handlePaymentFailed(invoice) {
  console.log('Payment failed:', invoice.id);
  
  
  const stripeCustomerId = invoice.customer;
  const customerEmail = invoice.customer_email;

  try {
    // Use the helper function to find the user.
    // Note: We don't update stripeCustomerId on failure, so the helper's update logic is less critical here, but still good for consistency.
    const user = await findUserByStripeData(stripeCustomerId, customerEmail);

    // Now proceed with logging based on whether the user was found
    if (user) {
      // Log the event in the ActivityLog table for the found user
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'Payment Failed',
          activityType: 'WARNING',
          details: {
            invoiceId: invoice.id,
            amountDue: invoice.amount_due,
            currency: invoice.currency,
          },
        },
      });
      console.log('Payment failed logged for user:', user.email);
    } else {
      // Log the event without userId if no user is found
      await prisma.activityLog.create({
        data: {
          action: 'Payment Failed - No User Found',
          activityType: 'WARNING',
          details: {
            invoiceId: invoice.id,
            customerId: invoice.customer,
            amountDue: invoice.amount_due,
            currency: invoice.currency,
          },
        },
      });
      console.warn('No user found for payment failed invoice customer ID:', invoice.customer);
    }
  } catch (err) {
    console.error('Failed to log payment failed event:', err.message);
    // Log the error in the ActivityLog table
    await prisma.activityLog.create({
      data: {
        action: 'Payment Failed - Error',
        activityType: 'ERROR',
        details: {
          error: err.message,
          invoiceId: invoice.id,
          customerId: invoice.customer,
        },
      },
    });
  }
}

module.exports = router;
