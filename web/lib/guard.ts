const ALLOWED_HOST = /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/** Accept only a Host header naming this machine, so a rebound DNS name cannot reach the server. */
export function hostAllowed(host: string | null): boolean {
  return host !== null && ALLOWED_HOST.test(host);
}
