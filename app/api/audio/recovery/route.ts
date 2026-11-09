import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { initial, type Ledger } from "@/app/ledger";
import { getDb } from "@/db";
import { learnerStates } from "@/db/schema";
import { listRecoverable } from "@/lib/recording-recovery";
import { crossOrigin, json } from "../../shared";

export const dynamic="force-dynamic";
export async function GET(request:Request){
  const user=await getChatGPTUser();
  if(!user)return json({error:"sign_in_required"},401);
  if(crossOrigin(request))return json({error:"invalid_origin"},403);
  if(request.headers.get("X-Bandroom-Account")!==user.userId)return json({error:"refresh_account"},428);
  const params=new URL(request.url).searchParams,day=Number(params.get("day")),phase=params.get("phase");
  if(!Number.isInteger(day)||day<11||day>62||(phase!=="part2"&&phase!=="followup"))return json({error:"invalid_question"},400);
  if(!env.BUCKET)return json({error:"recordings_unavailable"},503);
  const row=await getDb().select({state:learnerStates.state}).from(learnerStates).where(eq(learnerStates.userId,user.userId)).get();
  try{return json(await listRecoverable(env.BUCKET,user.userId,(row?.state??initial()) as Ledger,day,phase));}
  catch{return json({error:"lookup_unavailable"},503);}
}
