import { getChatGPTUser } from "@/app/chatgpt-auth";
import { coachData } from "@/lib/coach";
import { json } from "../shared";

export const dynamic = "force-dynamic";
export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return json({error:"sign_in_required"},401);
  return json(await coachData(user.userId));
}
