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
                [operation]: amount, // Use dynamic property to apply increment or decrement
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

module.exports = { updateUserCredits };
