import { getChatGPTUser } from "@/app/chatgpt-auth";
import { callCoach, coachTools } from "@/lib/coach";
import { crossOrigin, json, limitedBody } from "../api/shared";

export const dynamic = "force-dynamic";
const protocolVersion = "2026-07-28";
export async function POST(request:Request) {
  if (crossOrigin(request)) return json({error:"invalid_origin"},403);
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
    case "tools/list": return reply({tools:coachTools});
    case "ping": return reply({});
    case "tools/call": {
      if(typeof message.params?.name!=="string") return err(-32602,"Tool name required");
      const user=await getChatGPTUser();
      if(!user) return err(-32001,"Sign in to access your IELTS records.",401);
      return reply(await callCoach(user.userId,message.params.name,message.params.arguments??{}));
    }
    default: return err(-32601,"Method not found");
  }
}
