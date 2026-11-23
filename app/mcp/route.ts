import { getAuthContext } from "@/app/chatgpt-auth";
import { callCoach, coachTools } from "@/lib/coach";
import { mcpToolAllowed, mcpToolsForScope } from "@/lib/mcp-scope";
import { auditServiceCall } from "@/lib/service-audit";
import { isEmptyClaim } from "@/lib/claim-audit";
import { env } from "cloudflare:workers";
import { consentGate, crossOrigin, json, limitedBody } from "../api/shared";

export const dynamic = "force-dynamic";
const protocolVersion = "2026-07-28";

// MT-3 (S8.1): tools that read/process learner voice or voice-derived calibration.
// add_coach_feedback / complete_review_task only need consent for speaking attempts.
const ALWAYS_VOICE_TOOLS = new Set([
  "read_speaking_recording", "read_recording_bytes", "get_review_transfer",
  "record_pronunciation_verdict", "reset_pronunciation_profile", "read_pronunciation_profile",
]);
function voiceToolNeedsConsent(name: string, args: unknown): boolean {
  if (ALWAYS_VOICE_TOOLS.has(name)) return true;
  if (name === "add_coach_feedback" || name === "complete_review_task") {
    const a = (args ?? {}) as { stage?: unknown; recordingId?: unknown; groundedAnalysis?: unknown; analysis?: unknown };
    return a.stage === "speak" || Boolean(a.recordingId) || Boolean(a.groundedAnalysis) || Boolean(a.analysis);
  }
  return false;
}
export async function POST(request:Request) {
  if (crossOrigin(request)) return json({error:"invalid_origin"},403);
  // MT-4 (S12): bound anonymous/discovery spam per source IP (generous for normal
  // connector use; the authenticated runner is well under this). Fail-open if DB
  // is absent so a binding outage does not take down MCP.
  const ip=request.headers.get("CF-Connecting-IP")||request.headers.get("X-Forwarded-For")||"unknown";
  const mcpEnv=env as {DB?:unknown;BANDROOM_QUOTA_GATE?:string};
  if(mcpEnv.DB){
    const {rateLimit,quotaEnabled}=await import("@/lib/quota");
    if(quotaEnabled(mcpEnv)){
      const ok=await rateLimit(mcpEnv.DB as never,`mcp:ip:${ip}`,240,60_000);
      if(!ok) return json({error:"rate_limited",retryAfter:60},429);
    }
  }
  const body=await limitedBody(request,128*1024);
  if(body instanceof Response) return body;
  let message;
  try {message=JSON.parse(new TextDecoder().decode(body));} catch {return json({jsonrpc:"2.0",id:null,error:{code:-32700,message:"Parse error"}},400);}
  const id=message?.id??null;
  const err=(code:number,message:string,status=200)=>json({jsonrpc:"2.0",id,error:{code,message}},status);
  const reply=(result:unknown)=>json({jsonrpc:"2.0",id,result});
  if (message?.jsonrpc!=="2.0"||typeof message?.method!=="string") return err(-32600,"Invalid request",400);
  // Discovery exposes static interface metadata so the Sites plugin can register the tools.
  switch(message.method) {
    case "server/discover": return reply({supportedVersions:[protocolVersion], capabilities:{tools:{}}});
    case "tools/list": {
      // MT-2 (G-MCP-2): filter the tool inventory by the caller's scope.
      // Unknown/anonymous scope gets an empty list (no metadata leak).
      const listAuth=await getAuthContext();
      const allowed=new Set(mcpToolsForScope(listAuth.scope));
      return reply({tools:coachTools.filter(tool=>allowed.has(tool.name))});
    }
    case "ping": return reply({});
    case "tools/call": {
      if(typeof message.params?.name!=="string") return err(-32602,"Tool name required");
      const auth=await getAuthContext();
      if(!auth.user) return err(-32001,"Sign in to access your IELTS records.",401);
      if(!mcpToolAllowed(auth.scope,message.params.name))
        return err(-32003,"This tool is not available to the current identity scope.",403);
      const tool=coachTools.find(entry=>entry.name===message.params.name);
      if((env as {BANDROOM_READONLY?:string}).BANDROOM_READONLY==="1"&&!tool?.annotations?.readOnlyHint)
        return err(-32004,"Write operations are disabled in read-only mirror mode.",403);
      // MT-3 (S8.1): voice tools require active consent. For human scopes the
      // tenant is the caller; gate here. Service scopes (coach/coach-runner) act
      // on a task tenant resolved from the lease — that consent check happens in
      // the review-tool layer against lease.uid (S8.2), not the caller.
      if(auth.scope!=="coach"&&auth.scope!=="coach-runner"&&voiceToolNeedsConsent(message.params.name,message.params.arguments)){
        const denied=await consentGate(auth.user.userId);
        if(denied) return err(-32005,"Consent required for voice processing.",403);
      }
      // S7.1: only a lease verified by the review-tool layer may attribute the
      // audit row to a tenant. The callback fires during dispatch, so an
      // invalid/failed lease leaves this undefined and the audit stays
      // service-scoped (userId=null, taskId=null).
      let verifiedUid:string|undefined;
      const result=await callCoach(auth.user.userId,message.params.name,message.params.arguments??{},{
        onLeaseVerified:lease=>{verifiedUid=lease.uid;},
        scope:auth.scope??undefined,
      });
      // An idle daemon polls the queue every few seconds; an empty claim carries
      // no task, tenant or learner action, so it is not written to the audit
      // trail (D7 write budget). Every claim that returns a task is still audited.
      const emptyClaim=message.params.name==="claim_next_review_task"&&isEmptyClaim(result);
      if((auth.scope==="coach"||auth.scope==="coach-runner")&&!emptyClaim)
        void auditServiceCall(auth,message.params.name,message.params.arguments,result,
          result&&!(result as {isError?:boolean}).isError?verifiedUid:undefined);
      return reply(result);
    }
    default: return err(-32601,"Method not found");
  }
}
