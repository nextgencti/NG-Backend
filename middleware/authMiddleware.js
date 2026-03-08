const jwt = require('jsonwebtoken');

const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Access Denied. No token provided.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
    req.user = decoded; // Contains { uid, role }
    next();
  } catch (error) {
    console.error('JWT Verification Error:', error);
    return res.status(403).json({ success: false, message: 'Invalid or expired token.' });
  }
};

module.exports = verifyToken;
