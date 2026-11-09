// Bound both connection and body reads. Abort is best effort; the race also
// releases UI locks if a browser/network implementation never settles fetch.
export async function requestJSON<T=unknown>(url:string,init:RequestInit={},timeout=15_000):Promise<{response:Response;data:T}> {
  const controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>;
  const deadline=new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>{reject(Error('请求超时，结果尚未确认。请保留草稿并重试。'));controller.abort()},timeout);
  });
  try {
    return await Promise.race([deadline,(async()=>{
      const response=await fetch(url,{...init,signal:controller.signal});
      // Authentication redirects often have no JSON body.
      const data=await response.json().catch(()=>null) as T;
      return {response,data};
    })()]);
  } finally {clearTimeout(timer!)}
}
