export const dynamic = "force-dynamic";

// Cloudflare Access owns sign-out and re-challenges at /.
function redirectHome() {
  return new Response(null, {
    status: 302,
    headers: { Location: "/", "Cache-Control": "private, no-store" },
  });
}

export function GET() {
  return redirectHome();
}

export function POST() {
  return redirectHome();
}