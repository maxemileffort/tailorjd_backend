const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { updateUserCredits } = require('../services/credits');

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
      await handleChargeSucceeded(event.data.object);
      break;
    case 'charge.refunded':
      await handleChargeRefunded(event.data.object);
      break;
    case 'checkout.session.completed':
      // Allocate credits for successful one-time or initial subscription purchases
      await handleCheckoutSessionCompleted(event.data.object);
      break;
    case 'customer.subscription.created':
      await handleSubscriptionCreated(event.data.object);
      break;
    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(event.data.object);
      break;
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object);
      break;
    case 'invoice.payment_succeeded':
      // Allocate credits for recurring subscription renewals
      await handlePaymentSucceeded(event.data.object);
      break;
    case 'invoice.payment_failed':
      await handlePaymentFailed(event.data.object);
      break;
    case 'invoice.upcoming':
      await handleInvoiceUpcoming(event.data.object);
      break;
    case 'payment_intent.succeeded':
      await handlePaymentIntentSucceeded(event.data.object);
      break;
    case 'payment_intent.payment_failed':
      await handlePaymentIntentFailed(event.data.object);
      break;
    case 'payment_method.attached':
      await handlePaymentMethodAttached(event.data.object);
      break;
    case 'charge.dispute.created':
      await handleDisputeCreated(event.data.object);
      break;
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  // Acknowledge receipt of the event
  res.status(200).send('Received');
});

// Event Handlers

async function handleChargeSucceeded(charge) {
  console.log('Charge succeeded:', charge.id);

  try {
    // Find the user based on the customer ID
    const user = await prisma.user.findFirst({
      where: { stripeCustomerId: charge.customer },
    });

    if (user) {
      // Log the event in the ActivityLog table
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'Charge Succeeded',
          activityType: 'LOG',
          details: {
            chargeId: charge.id,
            amount: charge.amount,
            currency: charge.currency,
          },
        },
      });
      console.log('Charge succeeded logged for user:', user.email);
    } else {
      // Log the event without userId if no user is found
      await prisma.activityLog.create({
        data: {
          action: 'Charge Succeeded - No User Found',
          activityType: 'WARNING',
          details: {
            chargeId: charge.id,
            customerId: charge.customer,
            amount: charge.amount,
            currency: charge.currency,
          },
        },
      });
      console.warn('No user found for charge customer ID:', charge.customer);
    }
  } catch (err) {
    console.error('Failed to log charge succeeded event:', err.message);
    // Log the error in the ActivityLog table
    await prisma.activityLog.create({
      data: {
        action: 'Charge Succeeded - Error',
        activityType: 'ERROR',
        details: {
          error: err.message,
          chargeId: charge.id,
          customerId: charge.customer,
        },
      },
    });
  }
}

async function handleChargeRefunded(charge) {
  console.log('Charge refunded:', charge.id);

  try {
    // Find the user based on the customer ID
    const user = await prisma.user.findFirst({
      where: { stripeCustomerId: charge.customer },
    });

    if (user) {
      // Log the event in the ActivityLog table
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'Charge Refunded',
          activityType: 'LOG',
          details: {
            chargeId: charge.id,
            amountRefunded: charge.amount_refunded,
            reason: charge.refunds.data[0]?.reason || 'Unknown',
          },
        },
      });
      console.log('Charge refunded logged for user:', user.email);
    } else {
      // Log the event without userId if no user is found
      await prisma.activityLog.create({
        data: {
          action: 'Charge Refunded - No User Found',
          activityType: 'WARNING',
          details: {
            chargeId: charge.id,
            customerId: charge.customer,
            amountRefunded: charge.amount_refunded,
            reason: charge.refunds.data[0]?.reason || 'Unknown',
          },
        },
      });
      console.warn('No user found for charge customer ID:', charge.customer);
    }
  } catch (err) {
    console.error('Failed to log charge refunded event:', err.message);
    // Log the error in the ActivityLog table
    await prisma.activityLog.create({
      data: {
        action: 'Charge Refunded - Error',
        activityType: 'ERROR',
        details: {
          error: err.message,
          chargeId: charge.id,
          customerId: charge.customer,
        },
      },
    });
  }
}

async function handleCheckoutSessionCompleted(session) {
  console.log('Checkout session completed:', session.id);

  try {
    // Find the user based on the customer ID
    const user = await prisma.user.findFirst({
      where: { stripeCustomerId: session.customer },
    });

    const amount = 50;
    await updateUserCredits(user.id, amount, 'increment');

    if (user) {
      // Log the event in the ActivityLog table
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'Checkout Session Completed',
          activityType: 'LOG',
          details: {
            sessionId: session.id,
            amountTotal: session.amount_total,
            paymentStatus: session.payment_status,
          },
        },
      });
      console.log('Checkout session completed logged for user:', user.email);
    } else {
      // Log the event without userId if no user is found
      await prisma.activityLog.create({
        data: {
          action: 'Checkout Session Completed - No User Found',
          activityType: 'WARNING',
          details: {
            sessionId: session.id,
            customerId: session.customer,
            amountTotal: session.amount_total,
            paymentStatus: session.payment_status,
          },
        },
      });
      console.warn('No user found for session customer ID:', session.customer);
    }
  } catch (err) {
    console.error('Failed to log checkout session completed event:', err.message);
    // Log the error in the ActivityLog table
    await prisma.activityLog.create({
      data: {
        action: 'Checkout Session Completed - Error',
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

async function handleSubscriptionCreated(subscription) {
  console.log('Subscription created:', subscription.id);

  try {
    // Find the user based on the customer ID
    const user = await prisma.user.findFirst({
      where: { stripeCustomerId: subscription.customer },
    });

    if (user) {
      // Log the event in the ActivityLog table
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'Subscription Created',
          activityType: 'LOG',
          details: {
            subscriptionId: subscription.id,
            status: subscription.status,
            items: subscription.items.data.map((item) => ({
              priceId: item.price.id,
              quantity: item.quantity,
            })),
          },
        },
      });
      console.log('Subscription created logged for user:', user.email);
    } else {
      // Log the event without userId if no user is found
      await prisma.activityLog.create({
        data: {
          action: 'Subscription Created - No User Found',
          activityType: 'WARNING',
          details: {
            subscriptionId: subscription.id,
            customerId: subscription.customer,
            status: subscription.status,
          },
        },
      });
      console.warn('No user found for subscription customer ID:', subscription.customer);
    }
  } catch (err) {
    console.error('Failed to log subscription created event:', err.message);
    // Log the error in the ActivityLog table
    await prisma.activityLog.create({
      data: {
        action: 'Subscription Created - Error',
        activityType: 'ERROR',
        details: {
          error: err.message,
          subscriptionId: subscription.id,
          customerId: subscription.customer,
        },
      },
    });
  }
}

async function handleSubscriptionUpdated(subscription) {
  console.log('Subscription updated:', subscription.id);

  try {
    // Find the user based on the customer ID
    const user = await prisma.user.findFirst({
      where: { stripeCustomerId: subscription.customer },
    });

    if (user) {
      // Log the event in the ActivityLog table
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'Subscription Updated',
          activityType: 'LOG',
          details: {
            subscriptionId: subscription.id,
            status: subscription.status,
            items: subscription.items.data.map((item) => ({
              priceId: item.price.id,
              quantity: item.quantity,
            })),
          },
        },
      });
      console.log('Subscription updated logged for user:', user.email);
    } else {
      // Log the event without userId if no user is found
      await prisma.activityLog.create({
        data: {
          action: 'Subscription Updated - No User Found',
          activityType: 'WARNING',
          details: {
            subscriptionId: subscription.id,
            customerId: subscription.customer,
            status: subscription.status,
          },
        },
      });
      console.warn('No user found for subscription customer ID:', subscription.customer);
    }
  } catch (err) {
    console.error('Failed to log subscription updated event:', err.message);
    // Log the error in the ActivityLog table
    await prisma.activityLog.create({
      data: {
        action: 'Subscription Updated - Error',
        activityType: 'ERROR',
        details: {
          error: err.message,
          subscriptionId: subscription.id,
          customerId: subscription.customer,
        },
      },
    });
  }
}

async function handleSubscriptionDeleted(subscription) {
  const customerId = subscription.customer;

  try {
    const user = await prisma.user.findFirst({
      where: { stripeCustomerId: customerId },
    });

    if (!user) {
      console.error('User not found for customer ID:', customerId);
      return;
    }

    // Mark the user as unsubscribed
    await prisma.user.update({
      where: { id: user.id },
      data: { isSubscribed: false },
    });

    console.log('Subscription canceled for user:', user.email);
  } catch (err) {
    console.error('Failed to process subscription deletion event:', err.message);
  }
}

async function handlePaymentSucceeded(invoice) {
  const customerId = invoice.customer;

  try {
    const user = await prisma.user.findFirst({
      where: { stripeCustomerId: customerId },
    });

    if (!user) {
      console.error('User not found for customer ID:', customerId);
      return;
    }

    const amount = 50;
    await updateUserCredits(user.id, amount, 'increment');

    // Log the credit addition in the Credits table
    await prisma.credit.create({
      data: {
        userId: user.id,
        amount: 50,
        type: 'subscription',
        stripeProductId: process.env.STRIPE_PRICE_ID,
      },
    });

    console.log('Credits added for user:', user.email);
  } catch (err) {
    console.error('Failed to process payment succeeded event:', err.message);
  }
}

async function handlePaymentFailed(invoice) {
  console.log('Payment failed:', invoice.id);

  try {
    // Find the user based on the customer ID
    const user = await prisma.user.findFirst({
      where: { stripeCustomerId: invoice.customer },
    });

    if (user) {
      // Log the event in the ActivityLog table
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'Payment Failed',
          activityType: 'WARNING',
          details: {
            invoiceId: invoice.id,
            amountDue: invoice.amount_due,
            currency: invoice.currency,
            reason: invoice.payment_intent?.last_payment_error?.message || 'Unknown',
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

async function handleInvoiceUpcoming(invoice) {
  console.log('Invoice upcoming:', invoice.id);

  try {
    // Find the user based on the customer ID
    const user = await prisma.user.findFirst({
      where: { stripeCustomerId: invoice.customer },
    });

    if (user) {
      // Log the event in the ActivityLog table
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'Invoice Upcoming',
          activityType: 'LOG',
          details: {
            invoiceId: invoice.id,
            amountDue: invoice.amount_due,
            currency: invoice.currency,
            dueDate: invoice.due_date,
          },
        },
      });
      console.log('Invoice upcoming logged for user:', user.email);
    } else {
      // Log the event without userId if no user is found
      await prisma.activityLog.create({
        data: {
          action: 'Invoice Upcoming - No User Found',
          activityType: 'WARNING',
          details: {
            invoiceId: invoice.id,
            customerId: invoice.customer,
            amountDue: invoice.amount_due,
            currency: invoice.currency,
            dueDate: invoice.due_date,
          },
        },
      });
      console.warn('No user found for invoice upcoming customer ID:', invoice.customer);
    }
  } catch (err) {
    console.error('Failed to log invoice upcoming event:', err.message);
    // Log the error in the ActivityLog table
    await prisma.activityLog.create({
      data: {
        action: 'Invoice Upcoming - Error',
        activityType: 'ERROR',
        details: {
          error: err.message,
          invoiceId: invoice.id,
          customerId: invoice.customer,
        },
      }
    });
  };
}

async function handlePaymentIntentSucceeded(paymentIntent) {
  console.log('Payment intent succeeded:', paymentIntent.id);

  try {
    // Find the user based on the customer ID
    const user = await prisma.user.findFirst({
      where: { stripeCustomerId: paymentIntent.customer },
    });

    if (user) {
      // Log the event in the ActivityLog table
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'Payment Intent Succeeded',
          activityType: 'LOG',
          details: {
            paymentIntentId: paymentIntent.id,
            amountReceived: paymentIntent.amount_received,
            currency: paymentIntent.currency,
          },
        },
      });
      console.log('Payment intent succeeded logged for user:', user.email);
    } else {
      // Log the event without userId if no user is found
      await prisma.activityLog.create({
        data: {
          action: 'Payment Intent Succeeded - No User Found',
          activityType: 'WARNING',
          details: {
            paymentIntentId: paymentIntent.id,
            customerId: paymentIntent.customer,
            amountReceived: paymentIntent.amount_received,
            currency: paymentIntent.currency,
          },
        },
      });
      console.warn('No user found for payment intent customer ID:', paymentIntent.customer);
    }
  } catch (err) {
    console.error('Failed to log payment intent succeeded event:', err.message);
    // Log the error in the ActivityLog table
    await prisma.activityLog.create({
      data: {
        action: 'Payment Intent Succeeded - Error',
        activityType: 'ERROR',
        details: {
          error: err.message,
          paymentIntentId: paymentIntent.id,
          customerId: paymentIntent.customer,
        },
      },
    });
  }
}

async function handlePaymentIntentFailed(paymentIntent) {
  console.log('Payment intent failed:', paymentIntent.id);

  try {
    // Find the user based on the customer ID
    const user = await prisma.user.findFirst({
      where: { stripeCustomerId: paymentIntent.customer },
    });

    if (user) {
      // Log the event in the ActivityLog table
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'Payment Intent Failed',
          activityType: 'WARNING',
          details: {
            paymentIntentId: paymentIntent.id,
            amount: paymentIntent.amount,
            currency: paymentIntent.currency,
            reason: paymentIntent.last_payment_error?.message || 'Unknown',
          },
        },
      });
      console.log('Payment intent failed logged for user:', user.email);
    } else {
      // Log the event without userId if no user is found
      await prisma.activityLog.create({
        data: {
          action: 'Payment Intent Failed - No User Found',
          activityType: 'WARNING',
          details: {
            paymentIntentId: paymentIntent.id,
            customerId: paymentIntent.customer,
            amount: paymentIntent.amount,
            currency: paymentIntent.currency,
          },
        },
      });
      console.warn('No user found for payment intent customer ID:', paymentIntent.customer);
    }
  } catch (err) {
    console.error('Failed to log payment intent failed event:', err.message);
    // Log the error in the ActivityLog table
    await prisma.activityLog.create({
      data: {
        action: 'Payment Intent Failed - Error',
        activityType: 'ERROR',
        details: {
          error: err.message,
          paymentIntentId: paymentIntent.id,
          customerId: paymentIntent.customer,
        },
      }
    });
  };
}

async function handlePaymentMethodAttached(paymentMethod) {
  console.log('Payment method attached:', paymentMethod.id);

  try {
    // Find the user based on the customer ID
    const user = await prisma.user.findFirst({
      where: { stripeCustomerId: paymentMethod.customer },
    });

    if (user) {
      // Log the event in the ActivityLog table
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'Payment Method Attached',
          activityType: 'LOG',
          details: {
            paymentMethodId: paymentMethod.id,
            type: paymentMethod.type,
            card: paymentMethod.card
              ? {
                  brand: paymentMethod.card.brand,
                  last4: paymentMethod.card.last4,
                  expMonth: paymentMethod.card.exp_month,
                  expYear: paymentMethod.card.exp_year,
                }
              : null,
          },
        },
      });
      console.log('Payment method attached logged for user:', user.email);
    } else {
      // Log the event without userId if no user is found
      await prisma.activityLog.create({
        data: {
          action: 'Payment Method Attached - No User Found',
          activityType: 'WARNING',
          details: {
            paymentMethodId: paymentMethod.id,
            customerId: paymentMethod.customer,
            type: paymentMethod.type,
          },
        },
      });
      console.warn('No user found for payment method customer ID:', paymentMethod.customer);
    }
  } catch (err) {
    console.error('Failed to log payment method attached event:', err.message);
    // Log the error in the ActivityLog table
    await prisma.activityLog.create({
      data: {
        action: 'Payment Method Attached - Error',
        activityType: 'ERROR',
        details: {
          error: err.message,
          paymentMethodId: paymentMethod.id,
          customerId: paymentMethod.customer,
        },
      },
    });
  }
}

async function handleDisputeCreated(dispute) {
  console.log('Dispute created:', dispute.id);

  try {
    // Find the user based on the customer ID
    const user = await prisma.user.findFirst({
      where: { stripeCustomerId: dispute.customer },
    });

    if (user) {
      // Log the event in the ActivityLog table
      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: 'Dispute Created',
          activityType: 'WARNING',
          details: {
            disputeId: dispute.id,
            amount: dispute.amount,
            currency: dispute.currency,
            reason: dispute.reason,
            status: dispute.status,
          },
        },
      });
      console.log('Dispute created logged for user:', user.email);
    } else {
      // Log the event without userId if no user is found
      await prisma.activityLog.create({
        data: {
          action: 'Dispute Created - No User Found',
          activityType: 'WARNING',
          details: {
            disputeId: dispute.id,
            customerId: dispute.customer,
            amount: dispute.amount,
            currency: dispute.currency,
            reason: dispute.reason,
            status: dispute.status,
          },
        },
      });
      console.warn('No user found for dispute customer ID:', dispute.customer);
    }
  } catch (err) {
    console.error('Failed to log dispute created event:', err.message);
    // Log the error in the ActivityLog table
    await prisma.activityLog.create({
      data: {
        action: 'Dispute Created - Error',
        activityType: 'ERROR',
        details: {
          error: err.message,
          disputeId: dispute.id,
          customerId: dispute.customer,
        },
      },
    });
  }
}

module.exports = router;
