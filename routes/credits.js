const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { authenticate, isAdmin } = require('../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// Middleware to ensure the user is authenticated
router.use(authenticate);

// Endpoint for admin to add credits for a user
router.post('/admin/add-credits', isAdmin, async (req, res) => {
    const { userId, amount } = req.body;

    if (!userId || !amount) {
        return res.status(400).json({ message: 'User ID and amount are required' });
    }

    try {
        // Update the user's credit balance
        const user = await prisma.user.update({
            where: { id: userId },
            data: { creditBalance: { increment: amount } },
        });

        // Log this action in ActivityLog
        await prisma.activityLog.create({
            data: {
                userId,
                action: `Added ${amount} credits.`,
                activityType: 'LOG',
            },
        });

        res.status(200).json({ message: 'Credits added successfully', user });
    } catch (error) {
        res.status(500).json({ message: 'Error adding credits', error });
    }
});

// // Endpoint for users to purchase credits
// router.post('/buy-credits', async (req, res) => {
//     const { userId, amount, stripeProductId } = req.body;

//     if (!userId || !amount) {
//         return res.status(400).json({ message: 'User ID and amount are required' });
//     }

//     try {
//         // Process payment with Stripe (implementation needed)
        
//         // After successful purchase, update user's credit balance
//         const user = await prisma.user.update({
//             where: { id: userId },
//             data: { creditBalance: { increment: amount } },
//         });

//         // Log the purchase in ActivityLog
//         await prisma.activityLog.create({
//             data: {
//                 userId,
//                 action: `Purchased ${amount} credits.`,
//                 activityType: 'LOG',
//             },
//         });

//         res.status(200).json({ message: 'Credits purchased successfully', user });
//     } catch (error) {
//         res.status(500).json({ message: 'Error purchasing credits', error });
//     }
// });

// Endpoint for users to use credits
router.post('/use-credits', async (req, res) => {
    const { userId, amount } = req.body;

    if (!userId || !amount) {
        return res.status(400).json({ message: 'User ID and amount are required' });
    }

    try {
        // Fetch the user
        const user = await prisma.user.findUnique({ where: { id: userId } });
        
        // Check if user has sufficient credits
        if (user.creditBalance < amount) {
            return res.status(400).json({ message: 'Insufficient credits' });
        }

        // Deduct credits from user's account
        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: { creditBalance: { decrement: amount } },
        });

        // Log the credit usage in ActivityLog
        await prisma.activityLog.create({
            data: {
                userId,
                action: `Used ${amount} credits.`,
                activityType: 'LOG',
            },
        });

        res.status(200).json({ message: 'Credits used successfully', user: updatedUser });
    } catch (error) {
        res.status(500).json({ message: 'Error using credits', error });
    }
});


// Endpoint for users to get credit balance
router.get('/read-credits', async (req, res) => {
    const { user } = req;
    const userId = user.id;

    if (!userId) {
        return res.status(400).json({ message: 'User ID and amount are required' });
    }

    try {
        // Fetch the user
        const user = await prisma.user.findUnique({ where: { id: userId } });
        
        // Read user's credit balance
        const creditBalance = user.creditBalance;

        res.status(200).json({ creditBalance });
    } catch (error) {
        res.status(500).json({ message: 'Error finding credit credit balance:', error });
    }
});
module.exports = router;
