export function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorName (error: unknown, fallback: string): string {
  return error instanceof Error ? error.name : fallback;
}

export function errorCode (error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
