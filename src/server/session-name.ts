export const VALID_SESSION_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function validateSessionName(name: string): void {
  if (!VALID_SESSION_NAME.test(name)) {
    throw new Error("Use 1–64 letters, numbers, dots, dashes, or underscores.");
  }
}
