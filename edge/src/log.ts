const prefix = () => new Date().toISOString();
const debugTokens = (Bun.env.DEBUG ?? "")
  .split(/[ ,]/)
  .map((token) => token.trim())
  .filter(Boolean);
const shouldDebug = () =>
  debugTokens.includes("meshcore") ||
  debugTokens.includes("meshcore-edge") ||
  debugTokens.includes("*");

export const log = {
  info: (...args: unknown[]) => console.log(prefix(), "INFO", ...args),
  warn: (...args: unknown[]) => console.warn(prefix(), "WARN", ...args),
  error: (...args: unknown[]) => console.error(prefix(), "ERROR", ...args),
  debug: (...args: unknown[]) => {
    if (shouldDebug()) {
      console.debug(prefix(), "DEBUG", ...args);
    }
  },
};
