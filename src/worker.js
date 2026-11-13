const SESSION_DAYS=30, enc=new TextEncoder();
const json=(d,s=200,h={})=>new Response(JSON.stringify(d),{status:s,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store",...h}});
const uid=()=>crypto.randomUUID();
const b64=b=>{let s="";for(const x of new Uint8Array(b))s+=String.fromCharCode(x);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"")};
const unb64=s=>{s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";return Uint8Array.from(atob(s),c=>c.charCodeAt(0))};
const sha=async s=>b64(await crypto.subtle.digest("SHA-256",enc.encode(s)));
async function hashPass(p,salt=crypto.getRandomValues(new Uint8Array(16))){const k=await crypto.subtle.importKey("raw",enc.encode(p),"PBKDF2",false,["deriveBits"]);const b=await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt,iterations:100000},k,256);return `pbkdf2$100000$${b64(salt)}$${b64(b)}`}
async function verify(p,stored){const [kind,n,s,e]=stored.split("$");if(kind!=="pbkdf2"||n!=="100000")return false;return (await hashPass(p,unb64(s))).split("$")[3]===e}
const cookie=(r,n)=>{const v=(r.headers.get("Cookie")||"").split(";").map(x=>x.trim()).find(x=>x.startsWith(n+"="));return v?decodeURIComponent(v.slice(n.length+1)):null};
const setCookie=(v,age)=>`cfplanner_session=${encodeURIComponent(v)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
async function me(r,e){const t=cookie(r,"cfplanner_session");if(!t)return null;return await e.DB.prepare("SELECT u.id,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>?").bind(await sha(t),Math.floor(Date.now()/1000)).first()}
async function session(id,email,e){const t=b64(crypto.getRandomValues(new Uint8Array(32))),exp=Math.floor(Date.now()/1000)+SESSION_DAYS*86400;await e.DB.prepare("INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(?,?,?)").bind(await sha(t),id,exp).run();return json({ok:true,user:{id,email}},200,{"set-cookie":setCookie(t,SESSION_DAYS*86400)})}
const validDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s));
// First-launch schema bootstrap. The D1 V1 database already contains users,
// sessions, programs and weekly_entries (migration 0001). V2 creates its own
// tables here so no manual Wrangler migration command is required.
let schemaReady;
async function ensureV2Schema(env) {
  if(schemaReady) return schemaReady;
  schemaReady=(async()=>{
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS app_migrations (
      version TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('pending','running','done')),
      applied_at TEXT
    );
    CREATE TABLE IF NOT EXISTS program_wods (
      id TEXT PRIMARY KEY,
      program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      planned_comment TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(program_id, name)
    );
    CREATE INDEX IF NOT EXISTS program_wods_user_program
      ON program_wods(user_id, program_id, sort_order);
    CREATE TABLE IF NOT EXISTS training_sessions (
      id TEXT PRIMARY KEY,
      program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      wod_id TEXT NOT NULL REFERENCES program_wods(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_date TEXT NOT NULL,
      actual_comment TEXT NOT NULL DEFAULT '',
      session_count INTEGER NOT NULL DEFAULT 1 CHECK(session_count >= 1),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS training_sessions_user_date
      ON training_sessions(user_id, session_date DESC);
    CREATE INDEX IF NOT EXISTS training_sessions_wod_date
      ON training_sessions(wod_id, session_date DESC);
  `);
  // V2 schema is additive. Never reset user accounts during application startup.
  // The migration ledger is retained for diagnostics only; no D1 batch is needed.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO app_migrations(version,status,applied_at) VALUES(?,?,CURRENT_TIMESTAMP)"
  ).bind("v2-schema-20261113","done").run();
  })().catch(err=>{schemaReady=null;throw err});
  return schemaReady;
}
async function api(r,e,p){
 if(r.method==="POST"&&p==="/api/register"){const b=await r.json(),email=String(b.email||"").trim().toLowerCase(),pw=String(b.password||"");if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return json({error:"Adresse e-mail invalide."},400);if(pw.length<12)return json({error:"Mot de passe : 12 caractères minimum."},400);if(await e.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first())return json({error:"Ce compte existe déjà."},409);const id=uid();await e.DB.prepare("INSERT INTO users(id,email,password_hash) VALUES(?,?,?)").bind(id,email,await hashPass(pw)).run();return session(id,email,e)}
 if(r.method==="POST"&&p==="/api/login"){const b=await r.json(),email=String(b.email||"").trim().toLowerCase(),u=await e.DB.prepare("SELECT id,email,password_hash FROM users WHERE email=?").bind(email).first();if(!u||!(await verify(String(b.password||""),u.password_hash)))return json({error:"Identifiants incorrects."},401);return session(u.id,u.email,e)}
 if(r.method==="POST"&&p==="/api/logout"){const t=cookie(r,"cfplanner_session");if(t)await e.DB.prepare("DELETE FROM sessions WHERE id_hash=?").bind(await sha(t)).run();return json({ok:true},200,{"set-cookie":setCookie("",0)})}
 if(r.method==="GET"&&p==="/api/me"){const u=await me(r,e);return json({user:u||null})}
 const u=await me(r,e);if(!u)return json({error:"Connexion requise."},401);
 if(r.method==="GET"&&p==="/api/programs"){const x=await e.DB.prepare("SELECT * FROM programs WHERE user_id=? ORDER BY start_monday DESC").bind(u.id).all();return json({programs:x.results})}
 if(r.method==="POST"&&p==="/api/programs"){const b=await r.json(),name=String(b.name||"").trim().slice(0,100),start=b.start,end=b.end;if(!name||!validDate(start)||!validDate(end)||start>end)return json({error:"Vérifie le nom et les dates."},400);const overlap=await e.DB.prepare("SELECT id FROM programs WHERE user_id=? AND NOT(end_monday<? OR start_monday>?)").bind(u.id,start,end).first();if(overlap)return json({error:"Les dates chevauchent un autre programme."},409);const id=uid();await e.DB.prepare("INSERT INTO programs(id,user_id,name,start_monday,end_monday) VALUES(?,?,?,?,?)").bind(id,u.id,name,start,end).run();return json({ok:true,id})}
 let m=p.match(/^\/api\/programs\/([\w-]+)$/);if(m&&r.method==="PUT"){const b=await r.json(),name=String(b.name||"").trim().slice(0,100);if(!name)return json({error:"Nom requis."},400);await e.DB.prepare("UPDATE programs SET name=? WHERE id=? AND user_id=?").bind(name,m[1],u.id).run();return json({ok:true})}
 if(m&&r.method==="DELETE"){await e.DB.prepare("DELETE FROM programs WHERE id=? AND user_id=?").bind(m[1],u.id).run();return json({ok:true})}
 m=p.match(/^\/api\/programs\/([\w-]+)\/wods$/);if(m&&r.method==="GET"){const x=await e.DB.prepare("SELECT * FROM program_wods WHERE program_id=? AND user_id=? ORDER BY sort_order,created_at").bind(m[1],u.id).all();return json({wods:x.results})}
 if(m&&r.method==="POST"){const b=await r.json(),name=String(b.name||"").trim().slice(0,100),comment=String(b.planned_comment||"").slice(0,3000);if(!name)return json({error:"Nom du WOD requis."},400);const pid=m[1],ok=await e.DB.prepare("SELECT id FROM programs WHERE id=? AND user_id=?").bind(pid,u.id).first();if(!ok)return json({error:"Programme introuvable."},404);const id=uid();try{await e.DB.prepare("INSERT INTO program_wods(id,program_id,user_id,name,planned_comment,sort_order) VALUES(?,?,?,?,?,COALESCE((SELECT MAX(sort_order)+1 FROM program_wods WHERE program_id=?),0))").bind(id,pid,u.id,name,comment,pid).run()}catch{return json({error:"Un WOD porte déjà ce nom dans ce programme."},409)}return json({ok:true,id})}
 m=p.match(/^\/api\/wods\/([\w-]+)$/);if(m&&r.method==="PUT"){const b=await r.json(),name=String(b.name||"").trim().slice(0,100);if(!name)return json({error:"Nom requis."},400);try{await e.DB.prepare("UPDATE program_wods SET name=?,planned_comment=? WHERE id=? AND user_id=?").bind(name,String(b.planned_comment||"").slice(0,3000),m[1],u.id).run()}catch{return json({error:"Ce nom de WOD existe déjà dans le programme."},409)}return json({ok:true})}
 if(m&&r.method==="DELETE"){await e.DB.prepare("DELETE FROM program_wods WHERE id=? AND user_id=?").bind(m[1],u.id).run();return json({ok:true})}
 if(r.method==="GET"&&p==="/api/sessions"){const q=new URL(r.url).searchParams,from=q.get("from"),to=q.get("to");let sql="SELECT s.*,CASE WHEN w.name='__AUTRES__' THEN 'Autres' ELSE w.name END AS wod_name,w.planned_comment,p.name AS program_name FROM training_sessions s JOIN program_wods w ON w.id=s.wod_id JOIN programs p ON p.id=s.program_id WHERE s.user_id=?";const args=[u.id];if(validDate(from)){sql+=" AND s.session_date>=?";args.push(from)}if(validDate(to)){sql+=" AND s.session_date<=?";args.push(to)}sql+=" ORDER BY s.session_date DESC,s.created_at DESC";const x=await e.DB.prepare(sql).bind(...args).all();return json({sessions:x.results})}
 if(r.method==="POST"&&p==="/api/sessions"){const b=await r.json(),date=b.session_date,pid=b.program_id;let wid=b.wod_id;if(!validDate(date))return json({error:"Date invalide."},400);if(wid==="other"){let w=await e.DB.prepare("SELECT id FROM program_wods WHERE program_id=? AND user_id=? AND name='__AUTRES__'").bind(pid,u.id).first();if(!w){const id=uid();await e.DB.prepare("INSERT OR IGNORE INTO program_wods(id,program_id,user_id,name,planned_comment,sort_order) VALUES(?,?,?,'__AUTRES__','',999999)").bind(id,pid,u.id).run();w=await e.DB.prepare("SELECT id FROM program_wods WHERE program_id=? AND user_id=? AND name='__AUTRES__'").bind(pid,u.id).first()}wid=w.id}const w=await e.DB.prepare("SELECT id,program_id FROM program_wods WHERE id=? AND user_id=?").bind(wid,u.id).first();if(!w||w.program_id!==pid)return json({error:"WOD ou programme invalide."},400);const id=uid();await e.DB.prepare("INSERT INTO training_sessions(id,program_id,wod_id,user_id,session_date,actual_comment) VALUES(?,?,?,?,?,?)").bind(id,pid,wid,u.id,date,String(b.actual_comment||"").slice(0,3000)).run();return json({ok:true,id})}
 m=p.match(/^\/api\/sessions\/([\w-]+)$/);if(m&&r.method==="PUT"){const b=await r.json();if(!validDate(b.session_date))return json({error:"Date invalide."},400);let wid=b.wod_id;if(wid==="other"){let w=await e.DB.prepare("SELECT id FROM program_wods WHERE program_id=? AND user_id=? AND name='__AUTRES__'").bind(b.program_id,u.id).first();if(!w){const id=uid();await e.DB.prepare("INSERT OR IGNORE INTO program_wods(id,program_id,user_id,name,planned_comment,sort_order) VALUES(?,?,?,'__AUTRES__','',999999)").bind(id,b.program_id,u.id).run();w=await e.DB.prepare("SELECT id FROM program_wods WHERE program_id=? AND user_id=? AND name='__AUTRES__'").bind(b.program_id,u.id).first()}wid=w.id}const w=await e.DB.prepare("SELECT id,program_id FROM program_wods WHERE id=? AND user_id=?").bind(wid,u.id).first();if(!w||w.program_id!==b.program_id)return json({error:"WOD ou programme invalide."},400);await e.DB.prepare("UPDATE training_sessions SET program_id=?,wod_id=?,session_date=?,actual_comment=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?").bind(b.program_id,wid,b.session_date,String(b.actual_comment||"").slice(0,3000),m[1],u.id).run();return json({ok:true})}
 if(m&&r.method==="DELETE"){await e.DB.prepare("DELETE FROM training_sessions WHERE id=? AND user_id=?").bind(m[1],u.id).run();return json({ok:true})}
 if(r.method==="GET"&&p==="/api/stats"){const x=await e.DB.prepare("SELECT w.id,w.name,w.planned_comment,COUNT(s.id) AS sessions_count,COALESCE(SUM(s.session_count),0) AS total_sessions FROM program_wods w LEFT JOIN training_sessions s ON s.wod_id=w.id AND s.user_id=w.user_id WHERE w.user_id=? AND w.name<>'__AUTRES__' GROUP BY w.id ORDER BY total_sessions DESC,w.name").bind(u.id).all();return json({stats:x.results})}
 return json({error:"Route inconnue."},404)
}
export default {async fetch(r,e){const u=new URL(r.url);if(!u.pathname.startsWith("/api/"))return e.ASSETS.fetch(r);try{await ensureV2Schema(e);return await api(r,e,u.pathname)}catch(err){console.error("CFPlanner", {name:err?.name, message:err?.message, stack:err?.stack, cause:err?.cause});return json({error:"Erreur serveur. Réessaie."},500)}}};
