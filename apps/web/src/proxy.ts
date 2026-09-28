import { NextRequest, NextResponse } from "next/server";

const SECRET = process.env.DASHBOARD_SECRET;
const COOKIE_NAME = "intent_agent_auth";

export function proxy(req: NextRequest) {
  // No secret configured -- auth is off (local dev convenience). Once DASHBOARD_SECRET
  // is set (required before any public deploy), every request needs the cookie or header.
  if (!SECRET) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (pathname === "/login" || pathname === "/api/login") return NextResponse.next();

  const cookieOk = req.cookies.get(COOKIE_NAME)?.value === SECRET;
  const bearerOk = req.headers.get("authorization") === `Bearer ${SECRET}`;
  if (cookieOk || bearerOk) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
