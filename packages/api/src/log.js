import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.LOG_LEVEL];

/**
 * Structured-enough logging without a dependency.
 *
 * Deliberately not pino or winston. Nothing in the requirements asks for
 * log shipping, sampling, or redaction, and a logger is the easiest
 * dependency in the world to add later if one of those becomes real.
 */
function emit(level, message, fields) {
  if (LEVELS[level] < threshold) return;
  const line = { t: new Date().toISOString(), level, msg: message, ...fields };
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(JSON.stringify(line));
}

export const log = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};
