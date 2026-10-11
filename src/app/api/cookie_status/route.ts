import { NextResponse } from "next/server";
import { cookies } from 'next/headers'
import { corsHeaders } from "@/lib/utils";
// @ts-ignore -- plain .mjs helper, shared with node:test
import { cookieExpiry } from "@/lib/cookieExpiry.mjs";

export const dynamic = "force-dynamic";

/** Expiry date of the Suno session cookie. Never returns the cookie itself. */
export async function GET() {
  const header = (await cookies()).toString();
  const resolved = header.includes('__client') ? header : process.env.SUNO_COOKIE;
  return new NextResponse(JSON.stringify({ expires_at: cookieExpiry(resolved) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}
