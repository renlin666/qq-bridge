export class SocialMemoryError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'SocialMemoryError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const ERROR_CODES = Object.freeze({
  INVALID_CONTEXT: 'INVALID_CONTEXT',
  INVALID_INPUT: 'INVALID_INPUT',
  FORBIDDEN: 'FORBIDDEN',
  PERSON_DISABLED: 'PERSON_DISABLED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  UPSTREAM_OFFLINE: 'UPSTREAM_OFFLINE',
  INDEX_REJECTED: 'INDEX_REJECTED'
});

export function fail(code, message, details) {
  throw new SocialMemoryError(code, message, details);
}