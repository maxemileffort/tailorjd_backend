const sqlInjectionPattern = /('|--|\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|CREATE|ALTER|TRUNCATE|EXEC|GRANT|REVOKE|DESCRIBE|SHOW|USE|DATABASE)\b)/gi;

/**
 * Middleware to sanitize inputs to prevent SQL injection.
 */
const sanitizeInput = (req, res, next) => {
  const sanitize = (value) => {
    if (typeof value === 'string') {
      return value.replace(sqlInjectionPattern, '');
    } else if (Array.isArray(value)) {
      return value.map((item) => sanitize(item));
    } else if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, val]) => [key, sanitize(val)])
      );
    }
    return value;
  };

  req.body = sanitize(req.body);
  req.query = sanitize(req.query);
  req.params = sanitize(req.params);

  next();
};

module.exports = sanitizeInput;
