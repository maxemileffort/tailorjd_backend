const { PrismaClient } = require('@prisma/client');
const { app } = require('../index'); 

const prisma = new PrismaClient();

beforeAll(async () => {
  // Perform any setup before tests
  await prisma.user.deleteMany(); // Clear the database
});

afterAll(async () => {
  await prisma.$disconnect(); // Close database connection
});

module.exports = { prisma, app };
