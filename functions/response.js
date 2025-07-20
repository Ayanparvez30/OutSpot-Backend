// my-backend-project/my-backend-project/function/response.js

exports.true_status = (res, data, message = 'Success') => {
  return res.status(200).json({
    status: true,
    message,
    data,
  });
};

exports.false_status = (res, message = 'Failed') => {
  return res.status(400).json({
    status: false,
    message,
  });
};

exports.response_with_code = (res, code, message = 'Error') => {
  return res.status(code).json({
    status: false,
    message,
  });
};
