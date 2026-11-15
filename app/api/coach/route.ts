import { requireOwnerScope } from "@/lib/route-guard";
import { coachData } from "@/lib/coach";
import { json } from "../shared";

export const dynamic = "force-dynamic";
export async function GET() {
  const auth = await requireOwnerScope();
  if (auth instanceof Response) return auth;
  return json(await coachData(auth.user.userId));
}
