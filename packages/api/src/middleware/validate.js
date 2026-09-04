import { ApiError } from '../util/errors.js';

/**
 * Validate a request against a zod schema.
 *
 * Validation happens at the boundary and the handler downstream receives
 * parsed, typed data - it never re-checks shapes. zod's `parse` also
 * strips unknown keys, so a client cannot smuggle an extra field into an
 * object that later gets spread into a database write.
 */
export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(
        ApiError.badRequest(
          'validation_failed',
          'Request body failed validation',
          result.error.issues.map((i) => ({
            field: i.path.join('.') || '(body)',
            message: i.message,
          })),
        ),
      );
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return next(
        ApiError.badRequest(
          'validation_failed',
          'Query parameters failed validation',
          result.error.issues.map((i) => ({
            field: i.path.join('.') || '(query)',
            message: i.message,
          })),
        ),
      );
    }
    // Express 5 makes req.query a getter, so it cannot be reassigned.
    // The parsed result is handed to the handler on a field of our own.
    req.validatedQuery = result.data;
    next();
  };
}
