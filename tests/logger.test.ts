import { expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';

it('filters severity and neutralises terminal control characters', () => {
  const messages: string[] = [];
  const log = createLogger('warn', (message) => messages.push(message));
  log('info', 'hidden');
  log('warn', 'line\nforged\u001b');
  expect(messages).toEqual(['[WARN] line forged ']);
});

it('supports silent logging', () => {
  const messages: string[] = [];
  createLogger('silent', (message) => messages.push(message))('error', 'hidden');
  expect(messages).toEqual([]);
});
