import { describe, expect, it } from 'bun:test';

import {
  canPrompt,
  isJsonMode,
  isQuietMode,
  printJson,
  shouldRenderHumanOutput,
} from './cli-output.js';

describe('cli output mode helpers', () => {
  it('detects json mode', () => {
    expect(isJsonMode({ json: true })).toBe(true);
    expect(isJsonMode({ json: false })).toBe(false);
    expect(isJsonMode({})).toBe(false);
  });

  it('detects quiet mode', () => {
    expect(isQuietMode({ quiet: true })).toBe(true);
    expect(isQuietMode({ quiet: false })).toBe(false);
    expect(isQuietMode({})).toBe(false);
  });

  it('treats json/quiet as non-human output', () => {
    expect(shouldRenderHumanOutput({ json: true, quiet: false })).toBe(false);
    expect(shouldRenderHumanOutput({ json: false, quiet: true })).toBe(false);
    expect(shouldRenderHumanOutput({ json: true, quiet: true })).toBe(false);
    expect(shouldRenderHumanOutput({ json: false, quiet: false })).toBe(true);
  });

  it('never prompts in json or quiet modes', () => {
    expect(canPrompt({ json: true, quiet: false })).toBe(false);
    expect(canPrompt({ json: false, quiet: true })).toBe(false);
  });

  it('matches tty capability when human output is enabled', () => {
    expect(canPrompt({ json: false, quiet: false })).toBe(Boolean(process.stdout?.isTTY) && Boolean(process.stdin?.isTTY));
  });

  it('printJson defaults status to ok', () => {
    const chunks = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      printJson({ hello: 'world' });
    } finally {
      process.stdout.write = originalWrite;
    }

    const output = JSON.parse(chunks.join(''));
    expect(output.status).toBe('ok');
    expect(output.hello).toBe('world');
  });

  it('printJson infers warning from messages', () => {
    const chunks = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      printJson({ messages: [{ level: 'warning', message: 'heads up' }] });
    } finally {
      process.stdout.write = originalWrite;
    }

    const output = JSON.parse(chunks.join(''));
    expect(output.status).toBe('warning');
  });
});
