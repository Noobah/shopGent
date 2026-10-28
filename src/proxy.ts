import { NextResponse, type NextRequest } from "next/server";

/**
 * Proxy (formerly `middleware.ts` — renamed in Next 16).
 *
 * Two jobs:
 *  1. Attach security headers to every response (CSP, X-Content-Type-Options,
 *     Referrer-Policy, frame-ancestors).
 *  2. Convenience redirects: send unauthenticated users on `(app)` pages to
 *     /login, and authenticated users off `(auth)` pages to /chat.
 *
 * IMPORTANT (per the build prompt): this is a CONVENIENCE only. It does not hit
 * the DB to validate the session. Every API route and Server Action still calls
 * requireUser(), which is the real authorization boundary.
 */

// Routes that require an authenticated user to view.
const PROTECTED_PATHS = ["/chat", "/history", "/settings"];
// Routes only for signed-out users (signed-in users are bounced to /chat).
const AUTH_PATHS = ["/login", "/signup"];

const SESSION_COOKIE = "sp_session";

function isProtected(pathname: string): boolean {
  return PROTECTED_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function isAuthRoute(pathname: string): boolean {
  return AUTH_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function securityHeaders(): Headers {
  const h = new Headers();
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("X-Frame-Options", "DENY");
  // CSP tuned for Next.js (needs inline scripts/styles + eval in dev).
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
  h.set("Content-Security-Policy", csp);
  return h;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = request.cookies.has(SESSION_COOKIE);

  const headers = securityHeaders();

  // Convenience redirect: unauthenticated users off protected pages.
  if (isProtected(pathname) && !hasSession) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url, { headers });
  }

  // Convenience redirect: authenticated users off login/signup pages.
  if (isAuthRoute(pathname) && hasSession) {
    return NextResponse.redirect(new URL("/chat", request.url), { headers });
  }

  // Otherwise pass through, attaching security headers to the response.
  const response = NextResponse.next({ request });
  headers.forEach((value, key) => response.headers.set(key, value));
  return response;
}

export const config = {
  // Run on everything except static assets + api routes (handled in-route).
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
