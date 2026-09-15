import type { Config } from './config.js';

const ranks = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
type Level = Exclude<Config['LOG_LEVEL'], 'silent'>;

export function createLogger(
  level: Config['LOG_LEVEL'],
  write: (message: string) => void = (message) => console.error(message),
) {
  return (severity: Level, message: string) => {
    if (ranks[severity] >= ranks[level]) {
      // Callers pass operational summaries, never raw data, config, or provider errors.
      write(`[${severity.toUpperCase()}] ${message.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')}`);
    }
  };
}
