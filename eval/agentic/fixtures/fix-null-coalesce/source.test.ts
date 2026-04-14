import { describe, it, expect } from 'vitest';
import { mergeConfig, getConfigValue } from './source';

describe('mergeConfig', () => {
  it('uses defaults when no user config is provided', () => {
    const cfg = mergeConfig({});
    expect(cfg.retries).toBe(3);
    expect(cfg.verbose).toBe(true);
    expect(cfg.prefix).toBe('app');
  });

  it('preserves user-supplied truthy values', () => {
    const cfg = mergeConfig({ retries: 5, prefix: 'custom' });
    expect(cfg.retries).toBe(5);
    expect(cfg.prefix).toBe('custom');
  });

  it('preserves 0 as a valid user value for retries', () => {
    const cfg = mergeConfig({ retries: 0 });
    expect(cfg.retries).toBe(0);
  });

  it('preserves false as a valid user value for verbose', () => {
    const cfg = mergeConfig({ verbose: false });
    expect(cfg.verbose).toBe(false);
  });

  it('preserves empty string as a valid user value for prefix', () => {
    const cfg = mergeConfig({ prefix: '' });
    expect(cfg.prefix).toBe('');
  });
});

describe('getConfigValue', () => {
  it('returns user value of 0 instead of the default', () => {
    expect(getConfigValue({ timeout: 0 }, 'timeout')).toBe(0);
  });

  it('falls back to default when key is absent', () => {
    expect(getConfigValue({}, 'baseUrl')).toBe('https://api.example.com');
  });
});
