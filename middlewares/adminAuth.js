module.exports = function adminAuth(req, res, next) {
  if (req.session && req.session.adminUser) {
    res.locals.adminUser = req.session.adminUser;
    res.locals.messages = {
      success: req.flash('success'),
      error: req.flash('error'),
    };
    return next();
  }
  req.flash('error', 'Please log in to access the admin panel.');
  return res.redirect('/admin/login');
};
