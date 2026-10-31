/**
 * Requires req.user (set by requireAuth, which must run first) to have one
 * of the given roles. Every doctor-only route in this app is protected with
 * this middleware server-side — a patient token can never reach these
 * endpoints no matter what the client sends or which URL is typed in.
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do that.' });
    }
    return next();
  };
}

module.exports = { requireRole };
