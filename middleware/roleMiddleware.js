const requireRole = (roles) => {
  // If a single string is passed, convert to array
  if (typeof roles === 'string') {
    roles = [roles];
  }

  return (req, res, next) => {
    // req.user is populated by verifyToken
    if (!req.user || !req.user.role) {
      return res.status(403).json({ success: false, message: 'Access Denied. Role missing.' });
    }

    // Allow superadmin to access any route that requires admin
    let allowedRoles = [...roles];
    if (allowedRoles.includes('admin') && !allowedRoles.includes('superadmin')) {
      allowedRoles.push('superadmin');
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: `Access Denied. Requires one of: ${roles.join(', ')} privileges.` });
    }

    next();
  };
};

module.exports = requireRole;
