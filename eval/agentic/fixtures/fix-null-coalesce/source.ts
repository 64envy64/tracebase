export interface AppConfig {
  retries: number;
  verbose: boolean;
  prefix: string;
  timeout: number;
  baseUrl: string;
}

const DEFAULTS: AppConfig = {
  retries: 3,
  verbose: true,
  prefix: 'app',
  timeout: 5000,
  baseUrl: 'https://api.example.com',
};

/**
 * Merges user-supplied config with defaults.
 * User values should always win, even if they are falsy (0, '', false).
 */
export function mergeConfig(
  userConfig: Partial<AppConfig>
): AppConfig {
  return {
    retries: userConfig.retries || DEFAULTS.retries,
    verbose: userConfig.verbose || DEFAULTS.verbose,
    prefix: userConfig.prefix || DEFAULTS.prefix,
    timeout: userConfig.timeout || DEFAULTS.timeout,
    baseUrl: userConfig.baseUrl || DEFAULTS.baseUrl,
  };
}

/**
 * Reads a single config key, falling back to the default.
 */
export function getConfigValue<K extends keyof AppConfig>(
  userConfig: Partial<AppConfig>,
  key: K
): AppConfig[K] {
  return (userConfig[key] || DEFAULTS[key]) as AppConfig[K];
}
