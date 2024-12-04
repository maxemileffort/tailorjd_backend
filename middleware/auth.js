const jwt = require('jsonwebtoken');

// const authenticate = (req, res, next) => {
//   const token = req.headers.authorization?.split(' ')[1];

//   if (!token) {
//     return res.status(401).json({ error: 'Unauthorized access' });
//   }

//   try {
//     const decoded = jwt.verify(token, process.env.JWT_SECRET);
//     req.user = decoded; // Attach user info to request
//     next();
//   } catch (err) {
//     return res.status(401).json({ error: 'Invalid token' });
//   }
// };

const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) return res.sendStatus(401);

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if the session exists and is active
    const session = await prisma.sessions.findUnique({
      where: { token: token }
    });

    if (!session || !session.isActive || new Date() > session.expiry) {
      return res.sendStatus(403); // Forbidden
    }

    req.user = decoded; // Attach user info to request object
    next(); // Proceed to the next middleware
  } catch (err) {
    return res.sendStatus(403);
  }
};


const isAdmin = (req, res, next) => {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

module.exports = { authenticate, isAdmin };