// Tenant identity resolution for multi-tenant soft isolation (rev2 §2.1/§3.1).
// Run: node --test tests/tenant-identity.test.mjs
//
// Covers: normalization, domain/admin allowlisting, first-login provisioning
// (default pending), idempotent/race-safe re-resolution, active-only scope,
// and fail-closed behaviour with no DB or malformed identity.
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const require=createRequire(import.meta.url);
const wrangler=createRequire(require.resolve("wrangler/package.json"));
const esbuild=wrangler("esbuild");
const root=process.cwd();
const tmp=await mkdtemp(join(tmpdir(),"bandroom-tenant-"));
let count=0;

async function bundled(file){
  const out=join(tmp,file.split("/").at(-1).replace(".ts",".mjs"));
  await esbuild.build({entryPoints:[join(root,file)],outfile:out,bundle:true,format:"esm",platform:"node"});
  return import(pathToFileURL(out).href);
}

// Minimal fake D1 matching the exact SQL in lib/tenant-identity.ts.
function fakeDb(rows=new Map()){
  return {
    prepare(sql){
      let params=[];
      const stmt={
        bind(...v){params=v;return stmt;},
        async first(){
          if(sql.includes("FROM users") && sql.includes("idp_iss")){
            return rows.get(`${params[0]}|${params[1]}`) ?? null;
          }
          return null;
        },
        async run(){
          if(sql.startsWith("INSERT INTO users")){
            const [user_id,idp_iss,idp_sub,,role,status]=params;
            const key=`${idp_iss}|${idp_sub}`;
            if(!rows.has(key)) rows.set(key,{user_id,role,status});
          }
          return {};
        },
      };
      return stmt;
    },
  };
}

const policy={allowedDomains:["gmail.com","hotmail.com","outlook.com"],adminEmails:["boss@leadership.dev"]};

try{
  const {resolveTenant,scopeForTenant,normalizeEmail,splitList,emailDomain}=await bundled("lib/tenant-identity.ts");

  // --- pure helpers ---
  assert.equal(normalizeEmail("  Alice@Gmail.COM "),"alice@gmail.com");
  assert.deepEqual(splitList("Gmail.com, hotmail.com ,,outlook.com"),["gmail.com","hotmail.com","outlook.com"]);
  assert.equal(emailDomain("a.b@gmail.com"),"gmail.com");
  count+=3;

  // --- first login from allowed domain provisions PENDING learner ---
  const db=fakeDb();
  const id={idpIss:"https://team.cloudflareaccess.com",idpSub:"sub-alice",email:"Alice@Gmail.com"};
  const t1=await resolveTenant(db,id,policy,1000);
  assert.equal(t1.status,"pending");
  assert.equal(t1.role,"learner");
  assert.match(t1.userId,/^[0-9a-f-]{36}$/);
  assert.equal(scopeForTenant(t1),null); // pending must NOT get learner scope
  count+=4;

  // --- second resolution is idempotent (same tenant, no duplicate) ---
  const t2=await resolveTenant(db,id,policy,2000);
  assert.equal(t2.userId,t1.userId);
  count+=1;

  // --- existing ACTIVE row yields learner scope ---
  const activeDb=fakeDb(new Map([["iss|sub-bob",{user_id:"u-bob",role:"learner",status:"active"}]]));
  const t3=await resolveTenant(activeDb,{idpIss:"iss",idpSub:"sub-bob",email:"bob@gmail.com"},policy,1);
  assert.equal(t3.status,"active");
  assert.equal(scopeForTenant(t3),"learner");
  count+=2;

  // --- revoked/suspended never get scope ---
  for(const status of ["revoked","suspended"]){
    const d=fakeDb(new Map([[`iss|sub-${status}`,{user_id:`u-${status}`,role:"learner",status}]]));
    const t=await resolveTenant(d,{idpIss:"iss",idpSub:`sub-${status}`,email:"x@gmail.com"},policy,1);
    assert.equal(scopeForTenant(t),null);
  }
  count+=2;

  // --- admin email provisions ACTIVE admin immediately ---
  const adb=fakeDb();
  const t4=await resolveTenant(adb,{idpIss:"iss",idpSub:"sub-boss",email:"boss@leadership.dev"},policy,1);
  assert.equal(t4.status,"active");
  assert.equal(t4.role,"admin");
  assert.equal(scopeForTenant(t4),"learner"); // admins are active tenants for own data
  count+=3;

  // --- disallowed domain fails closed, no row created ---
  const ddb=fakeDb();
  const t5=await resolveTenant(ddb,{idpIss:"iss",idpSub:"sub-eve",email:"eve@evil.example"},policy,1);
  assert.equal(t5,null);
  count+=1;

  // --- no DB / malformed identity → null ---
  assert.equal(await resolveTenant(null,id,policy,1),null);
  assert.equal(await resolveTenant(db,{idpIss:"",idpSub:"s",email:"a@gmail.com"},policy,1),null);
  assert.equal(await resolveTenant(db,{idpIss:"i",idpSub:"",email:"a@gmail.com"},policy,1),null);
  assert.equal(await resolveTenant(db,{idpIss:"i",idpSub:"s",email:""},policy,1),null);
  count+=4;

  console.log(`PASS ${count} tenant-identity assertions`);
}catch(error){
  console.error("FAIL",error);
  process.exitCode=1;
}