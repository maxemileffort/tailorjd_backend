require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');

const authRoutes = require('./routes/auth'); // To handle authentication-related routes
const userRoutes = require('./routes/user'); // To handle CRUD operations for users
const subscriptionRoutes = require('./routes/subscription'); // Handles upgrades from free to subscribed
const webhookRoutes = require('./routes/webhooks'); // Only for signing Stripe transactions

const app = express();
const prisma = new PrismaClient();

const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
}));

// Routes
app.use('/api/webhooks', webhookRoutes); // Stripe transaction signing; expects raw body

app.use(express.json()); // Rest of routes expect json

app.use('/api/auth', authRoutes); // Authentication-related routes
app.use('/api/users', userRoutes); // CRUD operations for users
app.use('/api/subscription', subscriptionRoutes); // Strictly for upgrades and downgrades

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'An unexpected error occurred' });
});

// Export app for testing
module.exports = { app };

// Start the server if not in a test environment
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}