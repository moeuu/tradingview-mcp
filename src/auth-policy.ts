export const DEFAULT_TRADINGVIEW_AUTH_COOKIE_NAMES = [
  "sessionid",
  "sessionid_sign",
  "device_t",
] as const;

const AUTH_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_AUTH_NAMES = 16;

export function parseAuthenticationAllowlist(
  value: string | undefined,
  fallback: readonly string[],
  variableName: string,
): string[] {
  if (value === undefined) return uniqueLowercase(fallback);
  const trimmed = value.trim();
  if (trimmed === "") return [];
  const names = trimmed.split(",").map((item) => item.trim());
  if (
    names.length > MAX_AUTH_NAMES ||
    names.some((name) => !AUTH_NAME_PATTERN.test(name))
  ) {
    throw new Error(
      `${variableName} must contain at most ${MAX_AUTH_NAMES} comma-separated ASCII names.`,
    );
  }
  return uniqueLowercase(names);
}

function uniqueLowercase(names: readonly string[]): string[] {
  return [...new Set(names.map((name) => name.toLowerCase()))];
}
