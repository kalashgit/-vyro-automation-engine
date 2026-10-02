import "server-only";

function optionalValue(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function optionalUrl(name: string): string | undefined {
  const value = optionalValue(name);
  if (!value) return undefined;

  try {
    const url = new URL(value);
    if (
      name === "API_BASE_URL" &&
      url.protocol !== "https:" &&
      url.protocol !== "http:"
    ) {
      throw new Error("Unsupported protocol");
    }
  } catch {
    // Do not include potentially sensitive values in error messages.
    throw new Error(`Invalid URL in environment variable ${name}`);
  }

  return value;
}

/** Optional integration settings. Call from server-side integration modules. */
export function getServerEnv() {
  return {
    databaseUrl: optionalUrl("DATABASE_URL"),
    apiBaseUrl: optionalUrl("API_BASE_URL"),
    apiKey: optionalValue("API_KEY"),
  } as const;
}
