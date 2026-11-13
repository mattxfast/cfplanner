const SESSION_DAYS = 30;
const encoder = new TextEncoder();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}
function uid() { return crypto.randomUUID(); }
function b64(bytes) {
  let s = ""; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function unb64(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
async function sha256(s) { return b64(await crypto.subtle.digest("SHA-256", encoder.encode(s))); }
async function passwordHash(password, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({name:"PBKDF2", hash:"SHA-256", salt, iterations:100000}, key, 256);
  return `pbkdf2$100000$${b64(salt)}$${b64(bits)}`;
}
async function verifyPassword(password, stored) {
  const [kind, rounds, salt, expected] = stored.split("$");
  if (kind !== "pbkdf2" || Number(rounds) !== 100000) return false;
  const actual = await passwordHash(password, unb64(salt));
  return actual.split("$")[3] === expected;
}
function cookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  const part = raw.split(";").map(x=>x.trim()).find(x=>x.startsWith(name+"="));
  return part ? decodeURIComponent(part.slice(name.length+1)) : null;
}
function setCookie(value, maxAge) {
  return `cfplanner_session=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
async function currentUser(request, env) {
  const token = cookie(request, "cfplanner_session");
  if (!token) return null;
  const hash = await sha256(token);
  const row = await env.DB.prepare(
    "SELECT u.id, u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>?"
  ).bind(hash, Math.floor(Date.now()/1000)).first();
  return row || null;
}
async function requireUser(request, env) {
  const user = await currentUser(request, env);
  return user ? { user } : { response: json({error:"Connexion requise."}, 401) };
}
function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254; }
function mondayOf(date) {
  const d = new Date(`${date}T12:00:00Z`);
  const day = (d.getUTCDay()+6)%7;
  d.setUTCDate(d.getUTCDate()-day);
  return d.toISOString().slice(0,10);
}
async function api(request, env, path) {
  if (request.method === "POST" && path === "/api/register") {
    const body = await request.json();
    const email = String(body.email||"").trim().toLowerCase();
    const password = String(body.password||"");
    if (!validEmail(email)) return json({error:"Adresse e-mail invalide."},400);
    if (password.length < 12) return json({error:"Choisis un mot de passe d'au moins 12 caractères."},400);
    const exists = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
    if (exists) return json({error:"Un compte existe déjà avec cette adresse."},409);
    const id = uid(), hash = await passwordHash(password);
    await env.DB.prepare("INSERT INTO users(id,email,password_hash) VALUES(?,?,?)").bind(id,email,hash).run();
    return createSession(id, email, env);
  }
  if (request.method === "POST" && path === "/api/login") {
    const body = await request.json();
    const email = String(body.email||"").trim().toLowerCase();
    const row = await env.DB.prepare("SELECT id,email,password_hash FROM users WHERE email=?").bind(email).first();
    if (!row || !(await verifyPassword(String(body.password||""), row.password_hash)))
      return json({error:"Adresse e-mail ou mot de passe incorrect."},401);
    return createSession(row.id,row.email,env);
  }
  if (request.method === "POST" && path === "/api/logout") {
    const token = cookie(request,"cfplanner_session");
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE id_hash=?").bind(await sha256(token)).run();
    return json({ok:true},200,{ "set-cookie": setCookie("",0) });
  }
  if (request.method === "GET" && path === "/api/me") {
    const user = await currentUser(request,env);
    return user ? json({user}) : json({user:null});
  }
  const auth = await requireUser(request,env);
  if (auth.response) return auth.response;
  const user = auth.user;

  if (request.method === "GET" && path === "/api/programs") {
    const {results} = await env.DB.prepare("SELECT * FROM programs WHERE user_id=? ORDER BY start_monday DESC").bind(user.id).all();
    return json({programs:results});
  }
  if (request.method === "POST" && path === "/api/programs") {
    const b = await request.json();
    const name = String(b.name||"").trim().slice(0,100);
    const start = mondayOf(String(b.start||""));
    const end = mondayOf(String(b.end||""));
    if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start>end)
      return json({error:"Vérifie le nom et les dates du programme."},400);
    const overlap = await env.DB.prepare(
      "SELECT id FROM programs WHERE user_id=? AND NOT(end_monday<? OR start_monday>?)"
    ).bind(user.id,start,end).first();
    if (overlap) return json({error:"Un autre programme couvre déjà au moins une de ces semaines."},409);
    const id=uid();
    await env.DB.prepare("INSERT INTO programs(id,user_id,name,start_monday,end_monday) VALUES(?,?,?,?,?)")
      .bind(id,user.id,name,start,end).run();
    return json({ok:true,id});
  }
  const programMatch = path.match(/^\/api\/programs\/([a-f0-9-]+)$/);
  if (programMatch && request.method==="DELETE") {
    await env.DB.prepare("DELETE FROM programs WHERE id=? AND user_id=?").bind(programMatch[1],user.id).run();
    return json({ok:true});
  }
  if (request.method==="GET" && path==="/api/week") {
    const week=mondayOf(new URL(request.url).searchParams.get("date") || new Date().toISOString().slice(0,10));
    const {results}=await env.DB.prepare(
      "SELECT e.*,p.name AS program_name FROM weekly_entries e JOIN programs p ON p.id=e.program_id WHERE e.user_id=? AND e.week_monday=? ORDER BY e.rowid"
    ).bind(user.id,week).all();
    const programs=await env.DB.prepare("SELECT * FROM programs WHERE user_id=? AND start_monday<=? AND end_monday>=?").bind(user.id,week,week).all();
    return json({week,entries:results,programs:programs.results});
  }
  if (request.method==="POST" && path==="/api/entries") {
    const b=await request.json();
    const program=await env.DB.prepare("SELECT id FROM programs WHERE id=? AND user_id=?").bind(b.program_id,user.id).first();
    if(!program) return json({error:"Programme introuvable."},404);
    const week=mondayOf(String(b.week||""));
    const category=String(b.category||"").trim().slice(0,60);
    const target=Math.max(0,Math.min(99,Number(b.target_count)||0));
    const done=Math.max(0,Math.min(999,Number(b.done_count)||0));
    if(!category) return json({error:"Indique une catégorie de WOD."},400);
    const id=uid();
    await env.DB.prepare(`INSERT INTO weekly_entries(id,program_id,user_id,week_monday,category,target_count,done_count,planned_comment,actual_comment)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(program_id,week_monday,category) DO UPDATE SET target_count=excluded.target_count,done_count=excluded.done_count,planned_comment=excluded.planned_comment,actual_comment=excluded.actual_comment`)
      .bind(id,program.id,user.id,week,category,target,done,String(b.planned_comment||"").slice(0,2000),String(b.actual_comment||"").slice(0,2000)).run();
    return json({ok:true});
  }
  const entryMatch=path.match(/^\/api\/entries\/([a-f0-9-]+)$/);
  if(entryMatch && request.method==="DELETE") {
    await env.DB.prepare("DELETE FROM weekly_entries WHERE id=? AND user_id=?").bind(entryMatch[1],user.id).run();
    return json({ok:true});
  }
  return json({error:"Route inconnue."},404);
}
async function createSession(userId,email,env) {
  const token=b64(crypto.getRandomValues(new Uint8Array(32)));
  const expires=Math.floor(Date.now()/1000)+SESSION_DAYS*86400;
  await env.DB.prepare("INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(?,?,?)").bind(await sha256(token),userId,expires).run();
  return json({ok:true,user:{id:userId,email}},200,{"set-cookie":setCookie(token,SESSION_DAYS*86400)});
}
export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(url.pathname.startsWith("/api/")) {
      if(request.method==="OPTIONS") return new Response(null,{status:204,headers:{
        "access-control-allow-origin":url.origin,"access-control-allow-credentials":"true",
        "access-control-allow-methods":"GET,POST,DELETE,OPTIONS","access-control-allow-headers":"content-type"
      }});
      try { return await api(request,env,url.pathname); }
      catch(e) {
  console.error("CFPlanner API error:", e);
  return json({error:"Erreur serveur. Réessaie."},500);
}
    }
    return env.ASSETS.fetch(request);
  }
};
