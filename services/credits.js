const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const updateUserCredits = async (userId, amount, operation) => {
    // This function increments or decrements the users credit 
    // balance based on actions in the app.
    if (!userId || typeof amount !== 'number' || !['increment', 'decrement'].includes(operation)) {
        throw new Error(
            'Invalid parameters: userId must be defined, amount must be a number, and operation must be "increment" or "decrement".'
        );
    }

    try {
        // Determine the operation to perform
        const updateData = {
            creditBalance: {
                [operation]: parseInt(amount, 10), // Use dynamic property to apply increment or decrement
            },
        };

        // Update the user's credit balance
        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: updateData,
        });

        if (!updatedUser) {
            throw new Error(`Failed to ${operation} credits for userId: ${userId}`);
        }

        return updatedUser.creditBalance; // Return the updated credit balance
    } catch (error) {
        console.error(`Error ${operation}ing user credits:`, error);
        throw new Error(`An error occurred while ${operation}ing user credits.`);
    }
};

const fetchUserCredits = async (userId) => {
    // This function retrieves the user's credit
    // balance to determine if it's ok to use app functions.
    if (!userId) {
        throw new Error(
            'Invalid parameters: userId must be defined.'
        );
    }

    try {
        // Fetch the user's credit balance
        const userData = await prisma.user.findUnique({
            where: { id: userId },
        });

        const creditBalance = userData.creditBalance;

        if (!userData || !creditBalance) {
            throw new Error(`Failed to fetch credits for userId: ${userId}`);
        }
        // console.log(`creditBalance: ${creditBalance}`)
        return creditBalance; 
    } catch (error) {
        console.error(`Error fetching user credits:`, error);
        throw new Error(`An error occurred while fetching user credits.`);
    }
};

module.exports = { updateUserCredits, fetchUserCredits };
