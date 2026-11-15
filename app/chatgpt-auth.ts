import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth-adapter";
import type { AuthUser } from "@/lib/auth-adapter";

export { getAuthContext };
export type ChatGPTUser = AuthUser;

const SIGN_IN_PATH = "/signin-with-chatgpt";
const SIGN_OUT_PATH = "/signout-with-chatgpt";
const CALLBACK_PATH = "/callback";

// Compatibility shim: existing callers keep the historical user shape while
// identity resolution now lives in lib/auth-adapter.ts.
export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const context = await getAuthContext();
  return context.user;
}

// Self-hosted deployments authenticate at the edge (Cloudflare Access). There
// is no application-side login URL, so redirecting to / lets Access intercept
// the request instead of creating a sign-in redirect loop.
export async function requireChatGPTUser(returnTo: string): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (user) return user;
  // Kept for call-site compatibility; edge Access, not an app URL, owns login.
  void returnTo;
  redirect("/");
}

export function chatGPTSignInPath(returnTo: string): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `${SIGN_IN_PATH}?return_to=${encodeURIComponent(safeReturnTo)}`;
}

export function chatGPTSignOutPath(returnTo = "/"): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `${SIGN_OUT_PATH}?return_to=${encodeURIComponent(safeReturnTo)}`;
}

function safeRelativeReturnPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";

  let url: URL;
  try {
    url = new URL(value, "https://app.local");
  } catch {
    return "/";
  }
  if (url.origin !== "https://app.local") return "/";
  if (isReservedAuthPath(url.pathname)) return "/";

  return `${url.pathname}${url.search}${url.hash}`;
}

function isReservedAuthPath(pathname: string): boolean {
  return (
    pathname === SIGN_IN_PATH ||
    pathname === SIGN_OUT_PATH ||
    pathname === CALLBACK_PATH
  );
}
