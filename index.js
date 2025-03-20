require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');

const authRoutes = require('./routes/auth'); // To handle authentication-related routes
const userRoutes = require('./routes/user'); // To handle CRUD operations for users
const rewriteRoutes = require('./routes/rewrites'); // Business Logic
const subscriptionRoutes = require('./routes/subscription'); // Handles upgrades from free to subscribed
const webhookRoutes = require('./routes/webhooks'); // Only for signing Stripe transactions
const creditsRoutes = require('./routes/credits'); // Only monitors credit balances; no logic for money handling
const createCheckoutSession = require('./routes/checkout'); // checkouts and sessions related to checkouts
const contactRoutes = require('./routes/contact');
const articleRoutes = require('./routes/article'); // Import article routes

const sanitizeInput = require('./middleware/sanitizeInput');

const app = express();
const prisma = new PrismaClient();

const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());

// Check if production environment variable is set
const isProd = process.env.PROD === 'true' || process.env.PROD === true;

if (isProd) {
  // Production-specific CORS configuration
  const allowedOrigins = [
    'https://tailorjd.com',
    // 'https://example.com',
    // 'https://another-example.com',
    // 'https://yetanother-example.com',
    // 'http://192.168.1.1', // Example IP address
    // 'http://192.168.1.2', // Another IP address
    // 'http://192.168.1.3'  // Yet another IP address
  ];

  app.use(cors({
    origin: function(origin, callback) {
      // Allow requests with no origin (like mobile apps, curl requests)
      if (!origin || allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: 'GET, POST, PUT, DELETE, OPTIONS',
    allowedHeaders: 'Origin, X-Requested-With, Content-Type, Accept, Authorization'
  }));

  app.options('*', cors());
} else {
  // Development/Generic CORS configuration
  app.use(cors()); // Allow all origins
}

// Setting some required headers that I guess have been missing this whole time
// app.use((req, res, next) => {
//   res.header('Access-Control-Allow-Origin', 'https://tailorjd.com');
//   res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
//   res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
//   res.header('Access-Control-Allow-Credentials', 'true');
  
//   // Handle preflight requests
//   if (req.method === 'OPTIONS') {
//     return res.sendStatus(204);
//   }

//   next();
// });


app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // Limit each IP to 100 requests per windowMs
}));

// Routes
// This route doesn't use sql and needs to be raw.
app.use('/api/webhooks', webhookRoutes); // Stripe transaction signing; expects raw body

app.use(express.json()); // Rest of routes expect json
app.use(sanitizeInput); // Many of these have tables, so we sanitize their inputs

app.use('/api/auth', authRoutes); // Authentication-related routes
app.use('/api/users', userRoutes); // CRUD operations for users
app.use('/api/subscription', subscriptionRoutes); // Strictly for upgrades and downgrades
app.use('/api/rewrites', rewriteRoutes); // Handles processing of JDs and Resumes
app.use('/api/credits', creditsRoutes); // Handles credits logic
app.use('/api/checkouts', createCheckoutSession); // only checkouts
app.use('/api/contact', contactRoutes); // Handles contact form submisions
app.use('/api/articles', articleRoutes); // for rendering blog articles

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'An unexpected error occurred', req });
});

// Export app for testing
module.exports = { app };

// Start the server if not in a test environment
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}