// FitFactory — mode hors ligne.
// - Lectures (GET /api/…) : chaque réponse est gardée sur le téléphone ; sans réseau, la dernière copie est servie.
// - Modifications : sans réseau, elles sont mises en file d'attente (dans l'ordre), appliquées tout de suite aux
//   copies locales pour être visibles, puis rejouées au retour du réseau. Les créations de séance et de PR portent
//   un identifiant généré ici (client_id) : un rejeu ne crée jamais de doublon côté serveur.
// Chargé avant app.js, qui fournit l'envoi réseau et les noms affichés (FFOffline.init).
const FFOffline=(()=>{
 const CACHE="ff-cache:",QUEUE="ff-queue",OWNER="ff-cache-owner";
 const NEVER_QUEUED=/^\/(login|register|logout|admin\/|admin$|push\/)/;
 const store={
  get(key){try{return JSON.parse(localStorage.getItem(key))}catch{return null}},
  set(key,value){try{localStorage.setItem(key,JSON.stringify(value))}catch{}},
  del(key){try{localStorage.removeItem(key)}catch{}},
  keys(prefix){const out=[];try{for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k&&k.startsWith(prefix))out.push(k)}}catch{}return out}
 };
 let offline=false,flushing=null,hooks={send:null,describeSession:()=>({}),describePr:()=>({}),onChange:()=>{},onSynced:()=>{},onDropped:()=>{}};
 const queue=()=>store.get(QUEUE)||[];
 const state=()=>({offline,pending:queue().length});
 const changed=()=>{try{hooks.onChange(state())}catch{}};
 const setOffline=value=>{if(offline!==value){offline=value;changed()}};
 const uuid=()=>{if(crypto.randomUUID)return crypto.randomUUID();const b=crypto.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;const h=[...b].map(x=>x.toString(16).padStart(2,"0")).join("");return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)};
 const isNetworkError=error=>!!error?.offline;

 // ----- Application locale d'une modification sur une copie de réponse GET -----
 const weekRange=path=>{const m=path.match(/^\/week-data\?from=(\d{4}-\d{2}-\d{2})&to=(\d{4}-\d{2}-\d{2})$/);return m?{from:m[1],to:m[2]}:null};
 const inRange=(range,date)=>date>=range.from&&date<=range.to;
 function removeSession(data,id){data.sessions=(data.sessions||[]).filter(s=>s.id!==id);data.checks=(data.checks||[]).filter(c=>c.session_id!==id);data.catalogChecks=(data.catalogChecks||[]).filter(c=>c.session_id!==id)}
 function addSession(data,session,body){
  data.sessions=[session,...(data.sessions||[])].sort((a,b)=>String(b.session_date).localeCompare(String(a.session_date))||String(b.logged_at||"").localeCompare(String(a.logged_at||"")));
  data.checks=[...(data.checks||[]),...(body.movement_ids||[]).map(movement_id=>({session_id:session.id,movement_id}))];
  data.catalogChecks=[...(data.catalogChecks||[]),...(body.catalog_movement_ids||[]).map(catalog_movement_id=>({session_id:session.id,catalog_movement_id}))];
 }
 function patch(path,data,op){
  if(!data||typeof data!=="object")return data;
  const body=op.body||{},range=weekRange(path);let m;
  if(range){
   if(op.method==="POST"&&op.path==="/sessions"&&inRange(range,body.session_date)){
    removeSession(data,body.client_id);
    addSession(data,{...body,id:body.client_id,logged_at:op.at,pending:1,...hooks.describeSession(body)},body);
   }else if(op.method==="PUT"&&(m=op.path.match(/^\/sessions\/([\w-]+)$/))){
    const previous=(data.sessions||[]).find(s=>s.id===m[1]);removeSession(data,m[1]);
    if(inRange(range,body.session_date))addSession(data,{...(previous||{}),...body,id:m[1],pending:1,...hooks.describeSession(body)},body);
   }else if(op.method==="DELETE"&&(m=op.path.match(/^\/sessions\/([\w-]+)$/))){
    removeSession(data,m[1]);
   }else if(op.path==="/weekly-plans"&&inRange(range,body.week_start)){
    data.plans=(data.plans||[]).filter(x=>!(x.week_start===body.week_start&&x.wod_id===body.wod_id));
    if(op.method==="POST")data.plans.push({week_start:body.week_start,wod_id:body.wod_id,...hooks.describeSession({wod_id:body.wod_id})});
   }else if(op.method==="PUT"&&op.path==="/weekly-flags"&&inRange(range,body.week_start)){
    data.flags=(data.flags||[]).filter(x=>x.week_start!==body.week_start);data.flags.push({week_start:body.week_start,competition:body.competition?1:0});
   }
  }else if(path==="/prs"){
   if(op.method==="POST"&&op.path==="/prs"){
    data.records=(data.records||[]).filter(r=>r.id!==body.client_id);
    data.records.push({...body,id:body.client_id,created_at:op.at,pending:1,...hooks.describePr(body)});
   }else if(op.method==="PUT"&&(m=op.path.match(/^\/prs\/([\w-]+)$/))){
    data.records=(data.records||[]).map(r=>r.id===m[1]?{...r,...body,pending:1,...hooks.describePr(body)}:r);
   }else if(op.method==="DELETE"&&(m=op.path.match(/^\/prs\/([\w-]+)$/))){
    data.records=(data.records||[]).filter(r=>r.id!==m[1]);
   }
   if(data.records)data.records.sort((a,b)=>String(a.record_date).localeCompare(String(b.record_date))||String(a.created_at||"").localeCompare(String(b.created_at||"")));
  }
  return data;
 }
 const withPending=(path,data)=>queue().reduce((d,op)=>patch(path,d,op),data);

 // ----- Lecture -----
 async function read(path,fetcher){
  try{
   const data=await fetcher();setOffline(false);
   store.set(CACHE+path,data);
   return withPending(path,JSON.parse(JSON.stringify(data)));
  }catch(error){
   if(!isNetworkError(error))throw error;
   setOffline(true);
   const cached=store.get(CACHE+path);
   if(cached)return withPending(path,cached);
   throw error;
  }
 }

 // ----- Écriture -----
 function enqueue(op){
  const q=queue();q.push(op);store.set(QUEUE,q);
  setOffline(true);changed();
 }
 async function write(path,method,body,send){
  if(NEVER_QUEUED.test(path))return send(body);
  if(method==="POST"&&(path==="/sessions"||path==="/prs")&&body&&!body.client_id)body={...body,client_id:uuid()};
  const op={path,method,body:body??null,at:new Date().toISOString()};
  if(queue().length)await flush();
  if(queue().length){enqueue(op);return {ok:true,queued:true,id:body?.client_id}}
  try{const result=await send(body);setOffline(false);return result}
  catch(error){if(!isNetworkError(error))throw error;enqueue(op);return {ok:true,queued:true,id:body?.client_id}}
 }

 // ----- Resynchronisation : rejoue la file dans l'ordre, s'arrête à la première coupure réseau -----
 function flush(){
  if(flushing)return flushing;
  flushing=(async()=>{
   let done=0;
   while(queue().length){
    const op=queue()[0];
    try{await hooks.send(op.path,op.method,op.body);done++;setOffline(false)}
    catch(error){
     if(isNetworkError(error)){setOffline(true);break}
     if(error.status===401)break;
     try{hooks.onDropped(op,error)}catch{}
     done++;
    }
    const q=queue();q.shift();store.set(QUEUE,q);changed();
   }
   if(done)try{await hooks.onSynced()}catch{}
  })().finally(()=>{flushing=null;changed()});
  return flushing;
 }

 // ----- Propriétaire des données locales (changement de compte, déconnexion) -----
 function setOwner(userId){const owner=store.get(OWNER);if(owner&&owner!==userId){clear()}store.set(OWNER,userId)}
 function clear(){store.keys(CACHE).forEach(k=>store.del(k));store.del(QUEUE);store.del(OWNER);changed()}

 function init(options){
  hooks={...hooks,...options};
  addEventListener("online",()=>flush());
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"&&queue().length)flush()});
  setInterval(()=>{if(queue().length)flush()},20000);
  changed();
 }
 return {init,read,write,flush,clear,setOwner,state};
})();
