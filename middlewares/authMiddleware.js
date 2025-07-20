const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.securityKey = (req, res, next) => {
    const key = req.headers.security_key;
    if (!key || key !== process.env.SECURITY_KEY) {
        return res.status(403).json({ message: 'Invalid or missing security key' });
    }
    next();
};

exports.checkAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'Authorization token required' });
        }

        const token = authHeader.split(' ')[1];

        // Find user by token stored in `authorization` field (adjust if needed)
        const user = await prisma.user.findFirst({ where: { authorization: token } });
        if (!user) {
            return res.status(401).json({ message: 'Invalid authorization token' });
        }

        // Attach minimal user info for controller usage
        req.authData = {
            id: user.id,
            total_tokens: user.total_tokens,
            email: user.email,
            // add other fields if necessary
        };

        next();
    } catch (error) {
        console.error('Auth middleware error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

exports.checkEmail = async (req, res, next) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ message: 'Email is required' });

        const existing = await prisma.user.findFirst({ where: { email } });
        if (existing) {
            return res.status(409).json({ message: 'User already exists' });
        }
        next();
    } catch (error) {
        console.error('checkEmail middleware error:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};
