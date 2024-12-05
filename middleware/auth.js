const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// const authenticate = async (req, res, next) => {
//   const token = req.headers.authorization?.split(' ')[1];

//   if (!token) return res.sendStatus(401);

//   try {
//     const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
//     // Check if the session exists and is active
//     const session = await prisma.sessions.findFirst({
//       where: { token: token }
//     });

//     if (!session || !session.isActive || new Date() > session.expiry) {
//       console.log('Failed second auth.');
//       return res.sendStatus(403); // Forbidden
//     }

//     req.user = decoded; // Attach user info to request object
//     next(); // Proceed to the next middleware
//   } catch (err) {
//     console.log('Other error in auth process:', err);
//     return res.sendStatus(403);
//   }
// };

const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token missing' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const session = await prisma.sessions.findFirst({
      where: { token },
      include: { user: true },
    });

    if (!session || !session.isActive || session.expiry < new Date()) {
      console.log('session problem.')
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    req.user = session.user; // Attach user info to request
    req.session = session;   // Attach session info to request
    next();
  } catch (err) {
    console.error('Authentication error:', err);
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const isAdmin = (req, res, next) => {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

module.exports = { authenticate, isAdmin };