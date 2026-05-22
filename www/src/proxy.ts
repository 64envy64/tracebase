import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isProtectedRoute = createRouteMatcher(["/dashboard(.*)"]);

export default clerkMiddleware(async (auth, request) => {
  const demoMode =
    process.env.NEXT_PUBLIC_TRACEBASE_DEMO === "1" ||
    request.nextUrl.searchParams.get("demo") === "1" ||
    request.nextUrl.searchParams.get("demo") === "true";

  if (demoMode) {
    const headers = new Headers(request.headers);
    headers.set("x-tracebase-demo", "1");
    return NextResponse.next({ request: { headers } });
  }

  if (isProtectedRoute(request)) {
    await auth.protect({ unauthenticatedUrl: new URL("/login", request.url).toString() });
  }
}, (request) => ({
  signInUrl: new URL("/login", request.url).toString(),
  signUpUrl: new URL("/sign-up", request.url).toString(),
}));

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest|mp4|webm)).*)",
    "/(api|trpc)(.*)",
  ],
};
