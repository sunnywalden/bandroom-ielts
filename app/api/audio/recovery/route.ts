import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { requireUserScope } from "@/lib/route-guard";
import { initial, type Ledger } from "@/app/ledger";
import { getTenantDb } from "@/db";
import { learnerStates } from "@/db/schema";
import { listRecoverable } from "@/lib/recording-recovery";
import { consentGate, crossOrigin, json } from "../../shared";

export const dynamic="force-dynamic";
export async function GET(request:Request){
  const auth=await requireUserScope();
  if(auth instanceof Response)return auth;
  const user=auth.user;
  if(crossOrigin(request))return json({error:"invalid_origin"},403);
  if(request.headers.get("X-Bandroom-Account")!==user.userId)return json({error:"refresh_account"},428);
  const denied=await consentGate(user.userId);
  if(denied)return denied;
  const params=new URL(request.url).searchParams,day=Number(params.get("day")),phase=params.get("phase");
  if(!Number.isInteger(day)||day<11||day>62||(phase!=="part2"&&phase!=="followup"))return json({error:"invalid_question"},400);
  if(!env.BUCKET)return json({error:"recordings_unavailable"},503);
  const row=await getTenantDb(user.userId).select({state:learnerStates.state}).from(learnerStates).where(eq(learnerStates.userId,user.userId)).get();
  try{return json(await listRecoverable(env.BUCKET,user.userId,(row?.state??initial()) as Ledger,day,phase));}
  catch{return json({error:"lookup_unavailable"},503);}
}
