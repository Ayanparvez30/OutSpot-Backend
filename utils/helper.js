const bcrypt = require('bcrypt');

const hashPassword = (password) => {
  const saltRounds = 10;
  const salt = bcrypt.genSaltSync(saltRounds);
  return bcrypt.hashSync(password, salt);
};

const comparePassword = (plain, hashed) => {
  return bcrypt.compareSync(plain, hashed);
};

const randomKey = (length = 16) => {
  return require('crypto').randomBytes(length).toString('hex');
};

const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

module.exports = {
  hashPassword,
  comparePassword,
  randomKey,
  generateOTP,
};
