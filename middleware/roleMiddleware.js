const requireRole = (role) => {
  return (req, res, next) => {
    // req.user is populated by verifyToken
    if (!req.user || !req.user.role) {
      return res.status(403).json({ success: false, message: 'Access Denied. Role missing.' });
    }

    if (req.user.role !== role) {
      return res.status(403).json({ success: false, message: `Access Denied. Requires ${role} privileges.` });
    }

    next();
  };
};

module.exports = requireRole;
