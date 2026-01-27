const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.renderLogin = (req, res) => {
  if (req.session && req.session.adminUser) {
    return res.redirect('/admin/dashboard');
  }
  res.render('admin/pages/login', {
    layout: 'admin/layouts/auth',
    title: 'Login',
    messages: { error: req.flash('error'), success: req.flash('success') },
  });
};

exports.handleLogin = async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      req.flash('error', 'Username and password are required.');
      return res.redirect('/admin/login');
    }

    const admin = await prisma.adminUser.findFirst({
      where: {
        OR: [{ username }, { email: username }],
        isActive: true,
      },
    });

    if (!admin) {
      req.flash('error', 'Invalid credentials.');
      return res.redirect('/admin/login');
    }

    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) {
      req.flash('error', 'Invalid credentials.');
      return res.redirect('/admin/login');
    }

    req.session.adminUser = {
      id: admin.id,
      username: admin.username,
      email: admin.email,
      role: admin.role,
    };

    req.flash('success', `Welcome back, ${admin.username}!`);
    return res.redirect('/admin/dashboard');
  } catch (error) {
    console.error('Admin login error:', error);
    req.flash('error', 'An error occurred. Please try again.');
    return res.redirect('/admin/login');
  }
};

exports.handleLogout = (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
};
