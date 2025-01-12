const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

let stripeKey;
if(process.env.PROD==="true"){
  stripeKey = (process.env.STRIPE_SECRET_KEY);
} else {
  stripeKey = (process.env.STRIPE_TEST_SECRET_KEY);
}

const stripe = require('stripe')(stripeKey);

const updateCustId = async (userId, stripeId) => {
    // This function adds stripe customer IDs to their account info.
    // This is for them to be able to use the billing portal 
    // and manage their account.

    if (!userId || !stripeId) {
        throw new Error(
            'Invalid parameters: both userId and stripeId must be defined.'
        );
    }

    try {
        // Check if the user exists
        const userData = await prisma.user.findUnique({
            where: { id: userId },
        });

        if (!userData) {
            throw new Error(`Failed to fetch user data for userId: ${userId}`);
        }

        // Update user's stripe customer ID
        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: {
                stripeCustomerId: stripeId,
            },
        });

        console.log(`Stripe customer ID updated successfully for userId: ${userId}`);
        return updatedUser;
    } catch (error) {
        console.error(`Error updating Stripe customer ID for userId ${userId}:`, error);
        throw new Error(`An error occurred while updating user's Stripe customer ID.`);
    }
};

const createPortalSession = async (stripeId) => {
    // Creates the actual portal session for users to manage their accounts.

    if (!stripeId) {
        throw new Error('Invalid parameters: stripeId must be defined.');
    }

    try {
        // Fetch the user's credit balance and check if the user exists
        const userData = await prisma.user.findFirst({
            where: { stripeCustomerId: stripeId },
        });

        if (!userData) {
            throw new Error(`Failed to fetch user data for stripeCustomerId: ${stripeId}`);
        }

        // Create the Stripe billing portal session
        const portalSession = await stripe.billingPortal.sessions.create({
            customer: stripeId,
            return_url: process.env.BILLING_PORTAL_RETURN_URL ,
        });

        console.log(`Billing portal session created for stripeCustomerId: ${stripeId}`);
        return portalSession.url;
    } catch (error) {
        console.error(`Error creating billing portal session for stripeCustomerId ${stripeId}:`, error);
        throw new Error('An error occurred while creating the billing portal session.');
    }
};

module.exports = { updateCustId, createPortalSession };
