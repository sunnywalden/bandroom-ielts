export const dynamic = "force-dynamic";

// Cloudflare Access owns interactive sign-in. Keeping this compatibility URL
// avoids redirect loops from old links: bounce to / and let the edge challenge.
export function GET() {
  return new Response(null, {
    status: 302,
    headers: { Location: "/", "Cache-Control": "private, no-store" },
  });
}