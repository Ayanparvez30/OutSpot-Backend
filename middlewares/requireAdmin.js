// middlewares/requireAdmin.js
module.exports = function requireAdmin(req, res, next) {
  const roles = req.userRoles || [];
  if (roles.includes('admin') || roles.includes('teacher_admin')) return next();
  return res.status(403).json({ error: 'Admin only' });
};
