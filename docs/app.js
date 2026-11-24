// Multas del equipo — app web instalable para varios equipos (Firebase, plan gratuito)
const V = "10.12.2";
const CFG = self.FIREBASE_CONFIG || {};
const $ = s => document.querySelector(s);

if (!CFG.apiKey || String(CFG.apiKey).startsWith("PON_AQUI")) {
  document.querySelectorAll(".view").forEach(v => v.hidden = v.id !== "v-config");
  document.querySelector("nav.tabs").hidden = true;
  throw new Error("Falta firebase-config.js");
}

const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
const A = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`);
const F = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);

const app = initializeApp(CFG);
const auth = A.getAuth(app);
let db;
try { db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) }); }
catch { db = F.getFirestore(app); }

/* ---------- utilidades ---------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const LOC = (()=>{ try{ return {va:"ca-ES",en:"en-GB"}[JSON.parse(localStorage.getItem("multas.idioma"))]||"es-ES"; }catch{ return "es-ES"; } })();
const eur = n => (Math.round((+n||0)*100)/100).toLocaleString("es-ES",{maximumFractionDigits:2}) + " €";
const pad = n => String(n).padStart(2,"0");
const today = () => { const d=new Date(); return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate()); };
const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
const monthName = ym => { if(!ym) return ""; const [y,m]=ym.split("-"); return MESES[+m-1]+" de "+y; };
const dayName = ymd => { try{ const [y,m,d]=ymd.split("-").map(Number); return new Date(y,m-1,d).toLocaleDateString(LOC,{weekday:"long",day:"numeric",month:"long"}); }catch{ return ymd; } };
const store = {
  get(k,d){ try{ const v=localStorage.getItem(k); return v===null?d:JSON.parse(v); }catch{ return d; } },
  set(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch{} }
};
/* ---------- equipo ---------- */
const LEGACY_TEAM = "ONTINYENT";
const CODE_ABC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const genCode = () => { const a=new Uint32Array(6); crypto.getRandomValues(a); return [...a].map(n=>CODE_ABC[n%CODE_ABC.length]).join(""); };
const cleanCode = v => { v=String(v||"").trim(); const m=v.match(/[?&]e=([A-Za-z0-9]+)/); if(m) v=m[1]; return v.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,20); };
const legacyDevice = ["multas.lastSeen","multas.pushToken","multas.prefs","multas.hideInstall"].some(k=>{ try{ return localStorage.getItem(k)!==null; }catch{ return false; } });
let TEAM = cleanCode(new URLSearchParams(location.search).get("e")) || store.get("multas.team","") || "";
let teamOpen = false;
const teamLink = id => location.origin + location.pathname + "?e=" + id;

const UNIT_TXT = {fijo:"", minuto:"/min", cabeza:" por cabeza"};
const qtyTxt = m => m.unidad==="minuto" ? " · "+m.cantidad+" min" : (m.cantidad>1 ? " ×"+m.cantidad : "");

const DEFAULT_TYPES = [
  ["Tarde al entreno (+5 min)",3,"fijo"],["Falta al entreno sin avisar",5,"fijo"],["Tarde al partido sin avisar",1,"minuto"],
  ["Técnica / Flagrante",5,"fijo"],["Expulsión",3,"fijo"],["Técnica banquillo",2,"cabeza"],["Técnica entrenador",5,"fijo"],
  ["Tiro medio campo (viernes, el último)",2,"fijo"]];

const S = {
  jug: [], tipos: [], multas: [], eventos: [], avisos: [], showAllAv: false, openEv: null, planes: [], planResp: {}, planProp: {}, openPlan: null, rivales: [], rivNotas: [], rivalOpen: "", aj: {nombre:"", inicio:"", contador:"", admins:[], escudo:"", viernes:false},
  ready: {j:false,t:false,m:false,a:false},
  user: null, canWrite: false,
  selType: null, selPlayers: new Set(), openRank: null,
  lastSeen: 0,
  prefs: Object.assign({live:true, fri:true}, store.get("multas.prefs", {}))
};
const email = () => (S.user && !S.user.isAnonymous && S.user.email || "").toLowerCase();
const computeWrite = () => { S.canWrite = !!email() && (S.aj.admins||[]).map(x=>String(x).toLowerCase()).includes(email()); };

/* ---------- avisos en pantalla ---------- */
let toastT;
function toast(msg){
  document.querySelectorAll(".toast").forEach(t=>t.remove());
  const t=document.createElement("div"); t.className="toast"; t.setAttribute("role","status"); t.textContent=msg;
  document.body.appendChild(t); clearTimeout(toastT); toastT=setTimeout(()=>t.remove(),3200);
}
function errMsg(e){
  const c = e && e.code || "";
  if(c.includes("permission-denied")) return "No tienes permiso para hacer esto. Solo los administradores del equipo pueden.";
  if(c.includes("resource-exhausted")) return "Se ha superado el límite gratuito de hoy. Inténtalo mañana.";
  if(c.includes("unavailable")) return "Sin conexión. Se guardará cuando vuelva la red.";
  if(c.includes("invalid-credential")||c.includes("wrong-password")||c.includes("user-not-found")) return "Correo o contraseña incorrectos.";
  if(c.includes("email-already-in-use")) return "Ese correo ya tiene cuenta. Pulsa «Entrar».";
  if(c.includes("weak-password")) return "La contraseña necesita al menos 6 caracteres.";
  if(c.includes("invalid-email")) return "El correo no es válido.";
  if(c.includes("too-many-requests")) return "Demasiados intentos. Espera un poco.";
  return "No se pudo completar ("+(c||"error")+").";
}
async function run(fn, ok){
  try{ await fn(); if(ok) toast(ok); return true; }
  catch(e){ console.error(e); toast(errMsg(e)); return false; }
}
function armed(btn, label, fn){
  if(btn.dataset.armed==="1"){ btn.dataset.armed=""; fn(); return; }
  const orig=btn.textContent; btn.dataset.armed="1"; btn.classList.add("armed"); btn.textContent=label;
  setTimeout(()=>{ if(btn.isConnected && btn.dataset.armed==="1"){ btn.dataset.armed=""; btn.classList.remove("armed"); btn.textContent=orig; } },3500);
}
const teamRef = () => F.doc(db,"equipos",TEAM);
const col = c => F.collection(db,"equipos",TEAM,c);
const dref = (c,id) => c==="tokens" ? F.doc(db,"tokens",id) : c==="ajustes" ? teamRef() : F.doc(db,"equipos",TEAM,c,id);
async function copyText(txt, okMsg){
  try{ await navigator.clipboard.writeText(txt); toast(okMsg||"Copiado"); }
  catch{ const ta=document.createElement("textarea"); ta.value=txt; ta.setAttribute("readonly",""); ta.style.cssText="width:100%;min-height:120px"; document.activeElement?.closest(".card,.wrap")?.appendChild(ta); ta.select(); toast("Selecciona el texto y cópialo"); }
}

/* ---------- datos derivados ---------- */
const fromDate = () => S.aj.inicio ? S.aj.inicio+"-01" : "";
const inPeriod = m => !fromDate() || (m.fecha||"") >= fromDate();
const playerById = id => S.jug.find(p=>p.id===id);
const typeById = id => S.tipos.find(t=>t.id===id);
function sortPlayers(a,b){ if((a.rol==="entrenador")!==(b.rol==="entrenador")) return a.rol==="entrenador"?1:-1; return (a.nombre||"").localeCompare(b.nombre||"","es"); }
const activePlayers = () => S.jug.filter(p=>p.activo!==false).sort(sortPlayers);
const initial = n => (n||"?").trim().charAt(0).toUpperCase();
const hasDor = p => p && p.dorsal!==undefined && p.dorsal!==null && p.dorsal!=="";
const avTxt = p => hasDor(p) ? String(p.dorsal) : initial(p?.nombre);
const myPlayer = () => { const e=email(); return e ? S.jug.find(p=>String(p.email||"").toLowerCase()===e) : null; };
const isNew = m => (m.creado||0) > S.lastSeen && m.autor !== (S.user&&S.user.uid);
function totals(list){ let t=0,p=0; list.forEach(m=>{ t+=+m.importe||0; if(!m.pagada) p+=+m.importe||0; }); return {t, p, c:t-p}; }

/* ---------- navegación ---------- */
const VIEWS=["resumen","asistencia","anadir","planes","historial","equipo","ajustes","scouting","ayuda","fantasy","ficha","pizarra"];
function route(){
  document.querySelector("nav.tabs").hidden = !teamOpen; $(".pot").hidden = !teamOpen;
  if(!teamOpen){ document.querySelectorAll(".view").forEach(el=>{ el.hidden = el.id !== "v-inicio"; }); window.scrollTo(0,0); return; }
  const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "resumen";
  document.querySelectorAll(".view").forEach(el=>{ el.hidden = el.id !== "v-"+v; });
  document.querySelectorAll("nav.tabs a").forEach(a=>{ a.dataset.v===v ? a.setAttribute("aria-current","page") : a.removeAttribute("aria-current"); });
  if(v==="historial"){ renderHist(); markSeenSoon(); }
  if(v==="ficha") renderFicha();
  if(v==="pizarra"){ pzInit(); renderPizarra(); }
  if(v==="scouting") cargarFBCV();
  if(lang!=="es") setTimeout(()=>traducir(),50);
  window.scrollTo(0,0);
}
let seenT;
function markSeenSoon(){ clearTimeout(seenT); seenT=setTimeout(()=>{ S.lastSeen=Date.now(); store.set("multas.lastSeen."+TEAM,S.lastSeen); renderBadge(); },2500); }

/* ---------- pintar ---------- */
function renderAll(){ renderFantasy(); renderHeader(); renderResumen(); renderBote(); renderPagos(); renderLog(); renderCumple(); renderFicha(); renderPizarra(); renderAsis(); renderAdd(); renderHist(); renderEquipo(); renderAjustes(); renderPlanes(); renderScouting(); renderBadge(); }

function renderHeader(){
  const name = teamOpen ? (S.aj.nombre||"Tu equipo") : "Del equipo";
  $("#teamName").textContent = name;
  document.title = teamOpen && S.aj.nombre ? "Multas · "+S.aj.nombre : "Multas del equipo";
  const src = teamOpen && S.aj.escudo ? S.aj.escudo : "icons/balon.png";
  if($("#crestImg").getAttribute("src")!==src) $("#crestImg").src = src;
  const T = totals(S.multas.filter(inPeriod));
  $("#potTotal").textContent = eur(T.t);
  $("#potLabel").textContent = S.aj.inicio ? "Bote desde "+MESES[+S.aj.inicio.split("-")[1]-1] : "Bote";
}

function renderResumen(){
  const loaded = S.ready.j && S.ready.m;
  const list = S.multas.filter(inPeriod);
  const T = totals(list);
  $("#sTotal").textContent=eur(T.t); $("#sPend").textContent=eur(T.p); $("#sPaid").textContent=eur(T.c);
  $("#periodText").textContent = !loaded ? "Cargando datos del equipo…" :
    (S.aj.inicio ? "Contando desde "+monthName(S.aj.inicio)+" · "+list.length+" multas" : "Contando todas las multas · "+list.length+" en total");
  $("#countedBy").textContent = S.aj.contador ? "Conteo: "+S.aj.contador+" · Multas en efectivo" : "Multas en efectivo";
  $("#fridayBanner").hidden = !(new Date().getDay()===5 && S.aj.viernes && S.prefs.fri);
  renderAvisos();
  renderMe();
  const ch=cumpleHoy(); if(ch.length && $("#fridayBanner")) { const b=$("#cumpleBanner")||(()=>{ const x=document.createElement("div"); x.id="cumpleBanner"; x.className="banner"; $("#fridayBanner").after(x); return x; })(); b.hidden=false; b.innerHTML=`<p>🎂 ¡Hoy es el cumple de ${ch.map(p=>"<b>"+esc(shortName(p.nombre))+"</b>").join(" y ")}! Felicítale.</p>`; } else if($("#cumpleBanner")) $("#cumpleBanner").hidden=true;
  const me = myPlayer();

  const by = new Map();
  S.jug.forEach(p=>by.set(p.id,{p, t:0, pend:0, n:0, items:[]}));
  list.forEach(m=>{ let r=by.get(m.jugador); if(!r){ r={p:{id:m.jugador,nombre:m.jugadorNombre||"Sin nombre",activo:false}, t:0,pend:0,n:0,items:[]}; by.set(m.jugador,r); }
    r.t+=+m.importe||0; if(!m.pagada) r.pend+=+m.importe||0; r.n+=(m.unidad==="minuto"?1:(m.cantidad||1)); r.items.push(m); });
  const rows=[...by.values()].filter(r=>r.p.activo!==false || r.n>0).sort((a,b)=>b.t-a.t || sortPlayers(a.p,b.p));
  const max = Math.max(1,...rows.map(r=>r.t));
  const el=$("#rank");
  if(!loaded){ el.innerHTML='<li class="empty">Cargando…</li>'; return; }
  if(!rows.length){ el.innerHTML='<li class="empty"><b>Aún no hay nadie</b>'+(S.canWrite?"Ve a «Equipo» y añade a los jugadores.":"Cuando el administrador añada a los jugadores, aparecerán aquí.")+'</li>'; return; }
  el.innerHTML = rows.map((r,i)=>{
    const open = S.openRank===r.p.id;
    const items = r.items.sort((a,b)=>(b.fecha||"").localeCompare(a.fecha||"")||(b.creado||0)-(a.creado||0));
    const isMe = me && me.id===r.p.id;
    return `<li class="rrow ${isMe?"me":""}">
      <button type="button" class="rhead" data-rank="${esc(r.p.id)}" aria-expanded="${open}">
        <span class="pos">${r.t>0?i+1:"–"}</span>
        <span class="av ${r.p.rol==="entrenador"?"coach":""} ${hasDor(r.p)?"num":""}">${esc(avTxt(r.p))}</span>
        <span class="who"><b>${esc(r.p.nombre)}${isMe?' <span class="pill newp">tú</span>':""}</b><span>${r.n} ${r.n===1?"multa":"multas"}${r.p.rol==="entrenador"?" · entrenador":""}</span><span class="bar"><i style="width:${(r.t/max*100).toFixed(1)}%"></i></span></span>
        <span class="amt"><b>${eur(r.t)}</b>${r.t>0?(r.pend>0?`<span>debe ${eur(r.pend)}</span>`:`<span class="paid">pagado</span>`):""}</span>
      </button>
      ${open?`<div class="rbody">${items.length?items.map(m=>`<div class="row" style="justify-content:space-between"><span class="note">${esc(dayName(m.fecha))} · ${esc(m.tipoNombre)}${esc(qtyTxt(m))}</span><span><span class="pill ${m.pagada?"paid":"pend"}">${m.pagada?"cobrada":"pendiente"}</span> <b>${eur(m.importe)}</b></span></div>`).join(""):'<span class="note">Sin multas en este periodo.</span>'}
        <div class="row end"><button type="button" class="btn small ghost" data-ficha="${esc(r.p.id)}">👤 Ver ficha</button>${r.pend>0&&S.canWrite?`<button type="button" class="btn ok small" data-payall="${esc(r.p.id)}">Cobrar todo (${eur(r.pend)})</button>`:""}</div></div>`:""}
    </li>`;
  }).join("");
}

/* ---------- tablón de avisos ---------- */
function haceCuanto(ms){
  const m=Math.round((Date.now()-ms)/60000);
  if(m<1) return "ahora"; if(m<60) return "hace "+m+" min";
  const h=Math.round(m/60); if(h<24) return "hace "+h+" h";
  return new Date(ms).toLocaleDateString(LOC,{day:"numeric",month:"short"});
}
function renderAvisos(){
  const card=$("#avisosCard"); if(!card) return;
  // Avisos solo para administradores: colección aparte que solo ellos pueden leer
  if(S.canWrite && !S.avAdminUnsub && teamOpen){ S.avAdminUnsub=F.onSnapshot(col("avisosAdmin"), s=>{ S.avisosAdmin=s.docs.map(d=>({id:d.id,admin:true,...d.data()})); renderAvisos(); }, e=>console.warn(e)); unsubs.push(()=>{ S.avAdminUnsub?.(); S.avAdminUnsub=null; S.avisosAdmin=[]; }); }
  const list=[...S.avisos, ...(S.canWrite?(S.avisosAdmin||[]):[])].sort((a,b)=>(b.creado||0)-(a.creado||0));
  card.hidden = !teamOpen || (!list.length && !S.canWrite);
  $("#avForm").hidden=!S.canWrite;
  const seen=store.get("multas.avSeen."+TEAM,0);
  const shown=S.showAllAv?list:list.slice(0,3);
  $("#avCount").textContent = list.length>3 ? list.length+" avisos" : "";
  $("#avList").innerHTML = shown.length ? shown.map(a=>`<li class="aviso ${(a.creado||0)>seen&&a.autor!==S.user?.uid?"nuevo":""} ${a.admin?"adm-av":""}">
      ${a.admin?'<span class="pill old" style="align-self:flex-start">🛡️ Solo administradores</span>':""}<p>${esc(a.texto)}</p>
      <span class="meta"><span>${esc(a.autorNombre||"Administrador")} · ${esc(haceCuanto(a.creado||0))}</span>${S.canWrite?`<button type="button" class="btn small danger" data-avdel="${esc(a.id)}" data-avcol="${a.admin?"avisosAdmin":"avisos"}">Borrar</button>`:""}</span>
    </li>`).join("") + (list.length>3?`<li><button type="button" class="btn small ghost" id="avMore">${S.showAllAv?"Ver menos":"Ver todos ("+list.length+")"}</button></li>`:"")
    : '<li class="note">Todavía no hay avisos. Escribe el primero abajo.</li>';
  if(list.length && !$("#v-resumen").hidden){ clearTimeout(S.avSeenT); S.avSeenT=setTimeout(()=>store.set("multas.avSeen."+TEAM,Date.now()),4000); }
}

function renderMe(){
  const el=$("#meCard"); const e=email();
  if(!e || !S.ready.j || !S.jug.length){ el.hidden=true; return; }
  el.hidden=false;
  const me=myPlayer();
  if(me){
    const mine=S.multas.filter(m=>m.jugador===me.id && inPeriod(m)); const T=totals(mine);
    el.innerHTML=`<div class="who-line"><span class="row" style="gap:10px;flex-wrap:nowrap"><span class="av ${me.rol==="entrenador"?"coach":""} ${hasDor(me)?"num":""}">${esc(avTxt(me))}</span><span><h3>Tus multas</h3><b>${esc(me.nombre)}</b></span></span>
      <span class="amt"><b>${eur(T.p)}</b><span${T.p?"":' class="paid"'}>${T.p?"por pagar":"todo pagado"}</span></span></div>
      <p class="note">${mine.length} ${mine.length===1?"apunte":"apuntes"} · ${eur(T.t)} en total${S.aj.inicio?" desde "+esc(monthName(S.aj.inicio)):""}</p>
      ${pagoAviso(me)}
      <div class="row"><button type="button" class="btn small ghost" id="myHist">Ver mis multas</button></div>`;
  } else {
    const prev=$("#claimSel")?.value||"";
    const free=activePlayers().filter(p=>!p.email);
    el.innerHTML=`<h3>¿Quién eres?</h3><p class="note">Vincula tu cuenta (${esc(e)}) con tu nombre para ver lo que debes y recibir avisos de tus multas.</p>
      ${free.length?`<div class="row"><label class="f">Soy…<select id="claimSel"><option value="">Elige tu nombre</option>${free.map(p=>`<option value="${esc(p.id)}">${esc(p.nombre)}</option>`).join("")}</select></label><button type="button" class="btn" id="claimBtn">Soy yo</button></div>`
        :'<p class="note">Todos los nombres ya tienen una cuenta. Pide a un administrador que te vincule desde «Equipo».</p>'}`;
    if(prev && $("#claimSel")) $("#claimSel").value=prev;
  }
}

/* ---------- asistencia ---------- */
const EV_TXT={entreno:"Entreno",partido:"Partido",otro:"Evento"};
const AS_OPTS=[["si","Vino"],["tarde","Tarde"],["just","Justif."],["no","Faltó"]];
const AS_TXT={si:"vino",tarde:"llegó tarde",just:"falta justificada",no:"faltó"};
const attended = v => v==="si"||v==="tarde";
const evById = id => S.eventos.find(e=>e.id===id);
const evTitle = ev => (EV_TXT[ev.tipo]||"Evento")+(ev.nota?" · "+ev.nota:"");
const pkey = p => String(p?.email||"").toLowerCase();
const confirmOf = (ev,p) => p && p.email ? (ev.confirma||{})[pkey(p)] : undefined;
const noteOf = (ev,p) => p && p.email ? String((ev.notas||{})[pkey(p)]||"") : "";
const plazoCfg = () => { const p=S.aj.plazo||{}; return {activo:!!p.activo, aviso:+p.aviso||8, cierre:(p.cierre===0?0:(+p.cierre||3)), tipo:p.tipo||""}; };
const fmtHora = ms => new Date(ms).toLocaleTimeString(LOC,{hour:"2-digit",minute:"2-digit"});
const fmtCierre = ms => { const d=new Date(ms), t=new Date(); const same=d.toDateString()===t.toDateString();
  return (same?"hoy":d.toLocaleDateString(LOC,{weekday:"long",day:"numeric"}))+" a las "+fmtHora(ms); };
// Cierre del plazo: entrenos de mañana (antes de las 14:00) → el día anterior a las 23:59; el resto → X horas antes
const MANANA_HASTA = 14;
function calcCierre(fecha, hora, horasAntes){
  const start=new Date(fecha+"T"+hora);
  if(start.getHours() < MANANA_HASTA){ const d=new Date(start); d.setDate(d.getDate()-1); d.setHours(23,59,0,0); return d.getTime(); }
  return start.getTime() - horasAntes*3600e3;
}
const isClosed = ev => !!ev.cierre && Date.now() >= ev.cierre;
const pctTxt = (a,b) => b ? Math.round(a/b*100)+"%" : "–";
function asStats(){
  // Solo eventos pasados (o de hoy) con lista pasada y dentro del periodo del conteo
  const td=today(); const per={};
  S.eventos.filter(ev=>ev.fecha<=td && inPeriod(ev) && ev.asistencia && Object.keys(ev.asistencia).length).forEach(ev=>{
    Object.entries(ev.asistencia).forEach(([pid,v])=>{
      const k=ev.tipo==="partido"?"p":"e"; const r=per[pid]||(per[pid]={e:[0,0],p:[0,0]});
      r[k][1]++; if(attended(v)) r[k][0]++;
    });
  });
  return per;
}
function renderAsis(){
  if(!$("#v-asistencia")) return;
  renderDias(); renderRankMes(); renderCal();
  const er=$("#evRivalWrap"); if(er) er.hidden=$("#evTipo").value!=="partido";
  $("#evForm").hidden=!S.canWrite;
  if(!$("#evFecha").value) $("#evFecha").value=today();
  const td=today();
  const evs=[...S.eventos].sort((a,b)=>((a.fecha||"")+(a.hora||"")).localeCompare((b.fecha||"")+(b.hora||"")));
  // Un entreno o partido deja de estar en «Próximos» 2 h después de empezar (sin hora: al acabar el día)
  const finEv=e=>{ if(!e.hora){ const d=new Date(e.fecha+"T23:59"); return d.getTime(); } return new Date(e.fecha+"T"+e.hora).getTime()+2*3600e3; };
  const ahoraMs=Date.now();
  const next=evs.filter(e=>finEv(e)>ahoraMs), past=evs.filter(e=>finEv(e)<=ahoraMs).reverse();
  $("#evPastCount").textContent=past.length?`(${past.length})`:"";
  clearTimeout(S.asisT); const prox=next[0]; if(prox) S.asisT=setTimeout(renderAsis, Math.min(finEv(prox)-ahoraMs+1000, 6*3600e3));
  const per=asStats(); let te=[0,0], tp=[0,0];
  Object.values(per).forEach(r=>{ te[0]+=r.e[0]; te[1]+=r.e[1]; tp[0]+=r.p[0]; tp[1]+=r.p[1]; });
  $("#asEnt").textContent=pctTxt(te[0],te[1]); $("#asPar").textContent=pctTxt(tp[0],tp[1]);
  const n0=next[0]; $("#asNext").textContent = n0 ? (n0.fecha===td?"Hoy":new Date(n0.fecha+"T12:00").toLocaleDateString(LOC,{weekday:"short",day:"numeric"})) : "–";
  $("#asSub").textContent = S.aj.inicio ? "Porcentajes desde "+monthName(S.aj.inicio)+". Cuentan como asistencia «vino» y «tarde»." : "Cuentan como asistencia «vino» y «tarde».";
  const loading='<li class="empty">'+(S.ready.e?"":"Cargando…")+'</li>';
  $("#evNextList").innerHTML = next.length ? next.map(ev=>evCard(ev,true)).join("") : (S.ready.e?'<li class="empty"><b>Nada programado</b>'+(S.canWrite?"Crea el próximo entreno o partido arriba.":"Cuando el entrenador cree un entreno o partido, aparecerá aquí.")+'</li>':loading);
  $("#evPastList").innerHTML = past.length ? past.slice(0,S.showAllPast?999:6).map(ev=>evCard(ev,false)).join("")+(past.length>6&&!S.showAllPast?'<li><button type="button" class="btn small ghost" id="evMore">Ver todos ('+past.length+')</button></li>':"") : (S.ready.e?'<li class="empty">Todavía no hay entrenos ni partidos pasados.</li>':loading);
  // tabla por jugador
  const me=myPlayer();
  const rows=activePlayers().map(p=>{ const r=per[p.id]||{e:[0,0],p:[0,0]}; const a=r.e[0]+r.p[0], b=r.e[1]+r.p[1]; return {p,r,pct:b?a/b:-1}; }).sort((x,y)=>y.pct-x.pct||sortPlayers(x.p,y.p));
  $("#asTableNote").textContent = "Entrenos y partidos con lista pasada"+(S.aj.inicio?" desde "+monthName(S.aj.inicio):"")+".";
  $("#asTable").innerHTML = rows.length ? '<div class="astab">'+rows.map(({p,r,pct})=>`<div class="asrow"><span><b>${esc(p.nombre)}</b>${me&&me.id===p.id?' <span class="pill newp">tú</span>':""}<br><span class="note">Entrenos ${r.e[0]}/${r.e[1]} · Partidos ${r.p[0]}/${r.p[1]}</span></span><span></span><span class="pct ${pct<0?"":pct<.6?"lo":pct>=.85?"hi":""}">${pct<0?"–":Math.round(pct*100)+"%"}</span><span class="bar"><i style="width:${pct<0?0:(pct*100).toFixed(0)}%"></i></span></div>`).join("")+'</div>' : '<p class="note">Añade jugadores en «Equipo».</p>';
}
function evCard(ev, upcoming){
  const d=new Date((ev.fecha||today())+"T12:00");
  const open=S.openEv===ev.id, me=myPlayer(), ps=activePlayers();
  const as=ev.asistencia||{}; const marked=Object.keys(as).length; const vino=Object.values(as).filter(attended).length;
  let si=0,no=0; ps.forEach(p=>{ const v=confirmOf(ev,p); if(v==="si") si++; else if(v==="no") no++; });
  const conLinked=ps.filter(p=>p.email).length;
  const count = marked ? `${vino}<small>de ${marked} vinieron</small>` : (upcoming||ev.fecha===today() ? `${si}<small>van${no?" · "+no+" no":""}</small>` : `–<small>sin lista</small>`);
  const myV = me ? confirmOf(ev,me) : undefined;
  let html=`<li class="ev ${ev.tipo==="partido"?"partido":""} ${ev.fecha===today()?"today":""}">
    <div class="evhead"><span class="evdate"><b>${d.getDate()}</b><span>${MESES[d.getMonth()].slice(0,3)}</span></span>
      <span class="who"><b>${esc(evTitle(ev))}</b><span>${esc(d.toLocaleDateString(LOC,{weekday:"long"}))}${ev.hora?" · "+esc(ev.hora):""}${ev.fecha===today()?" · hoy":""}${ev.lugar?"<br>📍 "+esc(ev.lugar):""}</span></span>
      <span class="evcount">${count}</span></div>`;
  if(upcoming) html+=convHtml(ev);
  if(upcoming && ev.cierre) html+= isClosed(ev)
      ? `<span class="pill old" style="align-self:flex-start">Plazo cerrado${ev.plazoCerrado?" · ya se multó a quien no contestó":""}</span>`
      : `<span class="note">⏳ Contesta antes de <b>${esc(fmtCierre(ev.cierre))}</b> o habrá multa</span>`;
  if(upcoming && conLinked) html+=`<span class="note">${si} van · ${no} no van · ${conLinked-si-no} sin responder${ps.length>conLinked?` · ${ps.length-conLinked} sin cuenta`:""}</span>`;
  const cl=isClosed(ev)?"disabled":"";
  if(upcoming && me) html+=`<div class="row rsvp seg"><span class="note">¿Vas?</span><button type="button" data-rsvp="${esc(ev.id)}|si" aria-pressed="${myV==="si"}" ${cl}>Voy</button><button type="button" data-rsvp="${esc(ev.id)}|no" aria-pressed="${myV==="no"}" ${cl}>No voy</button></div>
    <div class="row"><input type="text" id="nt-${esc(ev.id)}" maxlength="80" value="${esc(noteOf(ev,me))}" placeholder="Comentario: solo a tirar, llegaré tarde…" aria-label="Comentario" style="flex:1;min-width:150px;min-height:38px;padding:6px 10px;font-size:15px"><button type="button" class="btn small ghost" data-rsvpnote="${esc(ev.id)}">Guardar</button></div>`;
  const notes = ps.map(p=>[p,noteOf(ev,p)]).filter(([,n])=>n);
  if(notes.length && !open) html+=`<div class="note">${notes.map(([p,n])=>`<b>${esc(p.nombre)}:</b> ${esc(n)}`).join("<br>")}</div>`;
  if(upcoming && !me && email()) html+=`<span class="note">Vincula tu cuenta en «Resumen» para poder decir si vas.</span>`;
  html+=`<div class="row"><button type="button" class="btn small ${S.canWrite&&!marked&&!upcoming?"":"ghost"}" data-evopen="${esc(ev.id)}" aria-expanded="${open}">${open?"Cerrar lista":(S.canWrite?"Pasar lista":"Ver lista")}</button>
    ${ev.tipo==="partido"&&ev.rival?`<button type="button" class="btn small ghost" data-scout="${esc(ev.rival)}">🔎 Scouting</button>`:""}
    ${upcoming?`<button type="button" class="btn small ghost" data-ics="${esc(ev.id)}" aria-label="Añadir al calendario">📅</button>`:""}
    ${upcoming&&ev.lugar&&!/ONTINYENT/i.test(ev.lugar)?`<a class="btn small ghost" style="text-decoration:none;display:inline-flex;align-items:center" href="${esc(mapaUrl(ev.lugar))}" target="_blank" rel="noopener">📍 Cómo llegar</a>`:""}
    ${S.canWrite&&upcoming&&ev.tipo==="partido"?`<button type="button" class="btn small ghost" data-conv="${esc(ev.id)}">📋 Convocar</button>`:""}
    ${S.canWrite&&upcoming?`<button type="button" class="btn small ghost" data-evping="${esc(ev.id)}" ${ev.avisar?"disabled":""}>${ev.avisar?"Aviso en camino…":"Avisar a todos ahora"}</button>`:""}
    ${S.canWrite?`<span style="flex:1"></span><button type="button" class="btn small danger" data-evdel="${esc(ev.id)}">Borrar</button>`:""}</div>`;
  if(!upcoming) html+=notaPartidoHtml(ev);
  if(open){
    html+='<div class="roll">';
    if(S.canWrite) html+=`<div class="row"><button type="button" class="btn small ok" data-allin="${esc(ev.id)}">Marcar el resto como «vino»</button></div>`;
    ps.forEach(p=>{
      const v=as[p.id], c=confirmOf(ev,p);
      const nt=noteOf(ev,p);
      const hint = (c==="si"?"dijo que iba":c==="no"?"dijo que no iba":p.email?"no respondió":"sin cuenta")+(nt?" · «"+nt+"»":"");
      html+=`<div class="rrowp"><span class="who"><b>${esc(p.nombre)}</b><span class="note"> ${hint}</span></span>`+
        (S.canWrite ? `<span class="seg">${AS_OPTS.map(([k,l])=>`<button type="button" data-att="${esc(ev.id)}|${esc(p.id)}|${k}" data-v="${k}" aria-pressed="${v===k}">${l}</button>`).join("")}</span>`
                    : `<span class="pill ${v==="si"?"paid":v==="no"?"pend":"old"}">${v?AS_TXT[v]:"—"}</span>`)+`</div>`;
    });
    const faltas=ps.filter(p=>as[p.id]==="no"||as[p.id]==="tarde");
    if(S.canWrite && ev.tipo==="entreno" && faltas.length && !ev.multado)
      html+=`<button type="button" class="btn small danger" data-evfine="${esc(ev.id)}">Multar: ${faltas.length} sin avisar o tarde</button><span class="note">Pone «Falta al entreno sin avisar» a quien faltó y «Tarde al entreno» a quien llegó tarde. No incluye las faltas justificadas.</span>`;
    if(ev.multado) html+='<span class="note">Las multas de este entreno ya se pusieron.</span>';
    html+='</div>';
  }
  return html+"</li>";
}

function renderAdd(){
  $("#roAdd").hidden = S.canWrite; $("#addForm").hidden = !S.canWrite;
  const tipos=[...S.tipos].sort((a,b)=>(a.orden??99)-(b.orden??99));
  if(S.selType && !typeById(S.selType)) S.selType=null;
  $("#typeGrid").innerHTML = tipos.length ? tipos.map(t=>`<button type="button" class="type" data-type="${esc(t.id)}" aria-pressed="${S.selType===t.id}"><b>${esc(t.nombre)}</b><span>${eur(t.precio)}${UNIT_TXT[t.unidad]||""}</span></button>`).join("")
    : '<p class="note">'+(S.ready.t?"No hay tipos de multa. Créalos en Ajustes.":"Cargando…")+'</p>';
  const ps=activePlayers();
  [...S.selPlayers].forEach(id=>{ if(!ps.find(p=>p.id===id)) S.selPlayers.delete(id); });
  $("#playerChips").innerHTML = ps.length ? ps.map(p=>`<button type="button" class="chip" data-player="${esc(p.id)}" aria-pressed="${S.selPlayers.has(p.id)}">${esc(p.nombre)}</button>`).join("")
    : '<p class="note">'+(S.ready.j?"No hay jugadores. Añádelos en Equipo.":"Cargando…")+'</p>';
  updatePreview();
}
const getQty = () => Math.min(99, Math.max(1, Math.round(+$("#qty").value||1)));
function updatePreview(){
  const t=typeById(S.selType); const n=S.selPlayers.size;
  const per = t && t.unidad==="minuto";
  $("#qtyLabel").textContent = per ? "Minutos tarde" : "Veces";
  const q = getQty();
  const each = t ? (+t.precio||0)*q : 0;
  $("#previewAmt").textContent = eur(each*n);
  const detail = per ? q+" min" : (q>1 ? q+" veces" : "");
  $("#previewText").textContent = !t||!n ? "Elige una falta y al menos un jugador" :
    (n>1 ? n+" jugadores × "+eur(each)+(detail?" ("+detail+")":"") : (playerById([...S.selPlayers][0])?.nombre||"")+(detail?" · "+detail:""));
  $("#addBtn").disabled = !t || !n;
  $("#addBtn").textContent = n>1 ? "Poner multa a "+n : "Poner multa";
}

function renderHist(){
  const sel=$("#fPlayer"); const cur=sel.value;
  const all=[...S.jug].sort(sortPlayers);
  sel.innerHTML='<option value="">Todos</option>'+all.map(p=>`<option value="${esc(p.id)}">${esc(p.nombre)}${p.activo===false?" (baja)":""}</option>`).join("");
  sel.value = all.find(p=>p.id===cur) ? cur : "";
  const st=$("#fState").value, old=$("#fOld").checked, pid=sel.value;
  let list=S.multas.filter(m=>(old||inPeriod(m)) && (!pid||m.jugador===pid) && (!st || (st==="paid")===!!m.pagada));
  list.sort((a,b)=>(b.fecha||"").localeCompare(a.fecha||"")||(b.creado||0)-(a.creado||0));
  const el=$("#histList");
  if(!S.ready.m){ el.innerHTML='<p class="empty">Cargando…</p>'; return; }
  if(!list.length){ el.innerHTML='<div class="empty"><b>Sin multas</b>'+(S.multas.length?"Nada coincide con estos filtros.":"Cuando alguien apunte una multa aparecerá aquí.")+'</div>'; return; }
  const T=totals(list);
  let html=`<p class="note">${list.length} apuntes · ${eur(T.t)} · por cobrar ${eur(T.p)}</p>`, lastDay="";
  list.forEach(m=>{
    if(m.fecha!==lastDay){ if(lastDay) html+="</ul>"; html+=`<div class="day">${esc(dayName(m.fecha))}</div><ul class="list">`; lastDay=m.fecha; }
    const p=playerById(m.jugador); const nw=isNew(m);
    html+=`<li class="entry ${nw?"new":""}">
      <div class="t"><b>${esc(p?.nombre||m.jugadorNombre||"Sin nombre")}</b><div>${esc(m.tipoNombre)}${esc(qtyTxt(m))}${m.nota?" · "+esc(m.nota):""}</div></div>
      <div class="p">${eur(m.importe)}</div>
      <div class="acts">
        ${nw?'<span class="pill newp">nueva</span>':""}
        <span class="pill ${m.pagada?"paid":"pend"}">${m.pagada?"cobrada":"por cobrar"}</span>
        ${!inPeriod(m)?'<span class="pill old">fuera del conteo</span>':""}
        ${S.canWrite?`<span style="flex:1"></span>
        <button type="button" class="btn small ${m.pagada?"ghost":"ok"}" data-pay="${esc(m.id)}">${m.pagada?"Deshacer cobro":"Cobrada"}</button>
        <button type="button" class="btn small danger" data-del="${esc(m.id)}">Quitar</button>`:""}
      </div></li>`;
  });
  html+="</ul>"; el.innerHTML=html;
}

function renderEquipo(){
  $("#playerForm").hidden=!S.canWrite;
  const cnt=id=>S.multas.filter(m=>m.jugador===id).length;
  const act=activePlayers(), ina=S.jug.filter(p=>p.activo===false).sort(sortPlayers);
  const row=(p,active)=>`<div class="prow">
      <span class="av ${p.rol==="entrenador"?"coach":""} ${hasDor(p)?"num":""}">${esc(avTxt(p))}</span>
      <span class="who" data-namebox="${esc(p.id)}"><b><a href="#ficha" data-ficha="${esc(p.id)}" style="color:inherit">${esc(p.nombre)}</a></b><span>${p.rol==="entrenador"?"Entrenador/a":"Jugador/a"} · ${cnt(p.id)} apuntes${S.canWrite?(p.email?" · "+esc(p.email):" · sin cuenta"):(p.email?" · con cuenta":"")}</span></span>
      ${S.canWrite?`<span class="row">
        <button type="button" class="btn small ghost" data-rename="${esc(p.id)}">✏️ Nombre y dorsal</button>
        <button type="button" class="btn small ghost" data-mail="${esc(p.id)}">Correo</button>
        ${active?`<button type="button" class="btn small danger" data-remove="${esc(p.id)}">Quitar</button>`
          :`<button type="button" class="btn small ghost" data-restore="${esc(p.id)}">Recuperar</button>${cnt(p.id)?"":`<button type="button" class="btn small danger" data-purge="${esc(p.id)}">Eliminar</button>`}`}
      </span>`:""}
    </div>`;
  const needSeed = S.canWrite && S.ready.t && !S.tipos.length;
  $("#activeList").innerHTML = (act.length?act.map(p=>row(p,true)).join(""):'<p class="note">'+(S.ready.j?"Todavía no hay nadie en el equipo.":"Cargando…")+'</p>')
    + (needSeed?'<button type="button" class="btn" id="seedBtn" style="margin-top:8px">Añadir multas de ejemplo</button>':"");
  $("#inactiveCard").hidden=!ina.length;
  $("#inactiveList").innerHTML=ina.map(p=>row(p,false)).join("");
}

let ajFilled=false;
function renderAjustes(){
  // equipo
  $("#tcName").textContent = S.aj.nombre||"Tu equipo";
  $("#tcCode").textContent = TEAM;
  $("#tcLink").value = teamLink(TEAM);
  $("#tcCrest").src = S.aj.escudo || "icons/balon.png";
  $("#teamAdmin").hidden = !S.canWrite;
  if(S.canWrite && document.activeElement!==$("#tcNameIn")) $("#tcNameIn").value = S.aj.nombre||"";
  $("#tcFri").checked = !!S.aj.viernes;
  $("#tcCrestDel").hidden = !S.aj.escudo;
  $("#nFriWrap").hidden = !S.aj.viernes;
  renderPagoCfg();
  renderAyuda();
  $("#sugNoCuenta").hidden=!!myPlayer(); $("#sugText").closest("label").hidden=!myPlayer(); $("#sugSend").hidden=!myPlayer();
  $("#backupCard").hidden=!isOwnerTeam();
  renderFanCfg();
  { const pl=plazoCfg(); const t=typeById(pl.tipo);
    $("#plSummary").textContent = pl.activo
      ? `Recordatorio ${pl.aviso} h antes del entreno (si es por la mañana, el día anterior a las 17:00). El plazo para contestar se cierra ${pl.cierre} h antes (si es por la mañana, el día anterior a las 23:59). 1 h antes del cierre se avisa otra vez a quien no haya contestado. Quien no conteste recibe «${t?t.nombre+" ("+eur(t.precio)+")":"multa sin elegir"}».`
      : "Desactivado: no hay plazo ni multa por no contestar. Los recordatorios llegan 8 h antes.";
    $("#plEdit").hidden = !S.canWrite;
    if(S.canWrite && !document.activeElement?.closest("#plazoForm")){
      $("#plActivo").checked=pl.activo; $("#plAviso").value=pl.aviso; $("#plCierre").value=pl.cierre;
      const tipos=[...S.tipos].sort((a,b)=>(a.orden??99)-(b.orden??99));
      const def = pl.tipo || (tipos.find(x=>/falta.*entreno/i.test(x.nombre))||tipos[0]||{}).id || "";
      $("#plTipo").innerHTML = tipos.map(x=>`<option value="${esc(x.id)}">${esc(x.nombre)} · ${eur(x.precio)}</option>`).join("");
      $("#plTipo").value = def;
    } }
  // cuenta
  const e=email();
  $("#loginForm").hidden = !!e;
  $("#accountOut").hidden = !e;
  $("#accountOut").innerHTML = e ? `<span><b>${esc(e)}</b><br><span class="note">${myPlayer()?"Eres "+esc(myPlayer().nombre)+" · ":"Sin vincular a ningún jugador · "}${S.canWrite?"Administrador: puedes apuntar y cobrar multas":"Puedes ver las multas"}</span></span><span class="row">${myPlayer()?'<button type="button" class="btn small ghost" id="unclaim">Desvincular</button>':""}<button type="button" class="btn small ghost" id="lOut">Salir</button></span>` : "";
  // administradores
  $("#adminCard").hidden = !S.canWrite;
  const owner=String(S.aj.propietario||"").toLowerCase();
  const admins=(S.aj.admins||[]).map(a=>String(a).toLowerCase());
  const nameOf=a=>S.jug.find(p=>pkey(p)===a)?.nombre;
  admins.sort((x,y)=>(y===owner)-(x===owner));
  $("#adminList").innerHTML = admins.map(a=>`<div class="adm"><span>${nameOf(a)?"<b>"+esc(nameOf(a))+"</b><br>":""}${esc(a)}${a===e?' <span class="note">· tú</span>':""}</span>${a===owner?'<span class="pill paid">propietario</span>':`<button type="button" class="btn small danger" data-admdel="${esc(a)}">Quitar</button>`}</div>`).join("");
  const cands=S.jug.filter(p=>p.activo!==false && p.email && !admins.includes(pkey(p))).sort(sortPlayers);
  $("#adminCands").innerHTML = cands.length ? '<p class="note" style="margin:8px 0 0">Jugadores con cuenta:</p>'+cands.map(p=>`<div class="adm"><span><b>${esc(p.nombre)}</b><br>${esc(p.email)}</span><button type="button" class="btn small" data-admadd="${esc(pkey(p))}">Hacer admin</button></div>`).join("")
    : '<p class="note" style="margin:8px 0 0">Cuando tus compañeros vinculen su cuenta («Soy yo»), aparecerán aquí para hacerlos administradores con un toque. También puedes añadir un correo abajo.</p>';
  // conteo
  $("#periodForm").querySelectorAll("input,button").forEach(i=>i.disabled=!S.canWrite);
  $("#typeForm").hidden=!S.canWrite;
  if(S.ready.a && !ajFilled){ $("#inicio").value=S.aj.inicio||""; $("#contador").value=S.aj.contador||""; ajFilled=true; }
  const tipos=[...S.tipos].sort((a,b)=>(a.orden??99)-(b.orden??99));
  const dis = S.canWrite?"":"disabled";
  $("#typeList").innerHTML = tipos.length ? tipos.map(t=>`<div class="trow">
      <input type="text" id="tn-${esc(t.id)}" value="${esc(t.nombre)}" aria-label="Nombre" ${dis}>
      <input type="number" id="tp-${esc(t.id)}" value="${esc(t.precio)}" min="0" step="0.5" aria-label="Precio en euros" inputmode="decimal" ${dis}>
      <select id="tu-${esc(t.id)}" aria-label="Cómo se cobra" ${dis}>${["fijo","minuto","cabeza"].map(u=>`<option value="${u}" ${t.unidad===u?"selected":""}>${{fijo:"Una vez",minuto:"Por minuto",cabeza:"Por cabeza"}[u]}</option>`).join("")}</select>
      ${S.canWrite?`<div class="row end"><button type="button" class="btn small ghost" data-tsave="${esc(t.id)}">Guardar</button><button type="button" class="btn small danger" data-tdel="${esc(t.id)}">Borrar</button></div>`:""}
    </div>`).join("") : '<p class="note">'+(S.ready.t?"No hay tipos de multa todavía.":"Cargando…")+'</p>';
  $("#nLive").checked=S.prefs.live; $("#nFri").checked=S.prefs.fri; $("#nMine").checked=!!S.prefs.mine;
  $("#nMineWrap").hidden=!myPlayer();
  renderPush();
}

function renderBadge(){
  const n=S.multas.filter(isNew).length;
  const b=$("#newBadge"); b.hidden=!n; b.textContent=n>99?"99+":n;
  try{ if(navigator.setAppBadge){ n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } }catch{}
}

/* ---------- instalar ---------- */
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform==="MacIntel" && navigator.maxTouchPoints>1);
let installEvt=null;
function renderInstall(){
  const b=$("#installBanner");
  if(standalone || store.get("multas.hideInstall",false)){ b.hidden=true; return; }
  if(isIOS){ b.hidden=false; b.innerHTML='<b>Instala la app:</b> pulsa el botón Compartir de Safari <span aria-hidden="true">⬆︎</span> y elige «Añadir a pantalla de inicio». <button type="button" class="btn small ghost" id="hideInstall">Ocultar</button>'; return; }
  if(installEvt){ b.hidden=false; b.innerHTML='<div class="who-line"><span><b>Instala la app</b> en tu móvil para abrirla como cualquier otra.</span><span class="row"><button type="button" class="btn small" id="doInstall">Instalar</button><button type="button" class="btn small ghost" id="hideInstall">Ahora no</button></span></div>'; return; }
  b.hidden=true;
}
addEventListener("beforeinstallprompt", e=>{ e.preventDefault(); installEvt=e; renderInstall(); });
addEventListener("appinstalled", ()=>{ installEvt=null; $("#installBanner").hidden=true; toast("App instalada"); });

/* ---------- notificaciones push ---------- */
let messaging=null, M=null;
async function pushSupported(){
  if(!self.FIREBASE_VAPID_KEY || !("serviceWorker" in navigator) || !("Notification" in self)) return false;
  try{ M = M || await import(`https://www.gstatic.com/firebasejs/${V}/firebase-messaging.js`); return await M.isSupported(); }catch{ return false; }
}
async function renderPush(){
  const st=$("#pushState"), btn=$("#pushBtn");
  const tok=store.get("multas.pushToken","");
  if(!self.FIREBASE_VAPID_KEY){ st.textContent="Notificaciones del móvil: no configuradas (ver GUIA.md, paso 6)"; btn.hidden=true; return; }
  if(isIOS && !standalone){ st.textContent="En iPhone, instala primero la app en la pantalla de inicio para recibir notificaciones."; btn.hidden=true; return; }
  if(!("Notification" in self)){ st.textContent="Este navegador no admite notificaciones."; btn.hidden=true; return; }
  if(Notification.permission==="denied"){ st.textContent="Has bloqueado las notificaciones. Actívalas en los ajustes del navegador o del móvil."; btn.hidden=true; return; }
  btn.hidden=false;
  if(tok && Notification.permission==="granted"){ st.textContent="Notificaciones del móvil: activadas"; btn.textContent="Desactivar"; btn.dataset.on="1"; }
  else { st.textContent="Notificaciones del móvil: desactivadas"; btn.textContent="Activar notificaciones"; btn.dataset.on=""; }
}
async function enablePush(){
  if(!(await pushSupported())){ toast("Este dispositivo no admite notificaciones push."); return; }
  const perm = await Notification.requestPermission();
  if(perm!=="granted"){ renderPush(); return; }
  try{
    const reg = await navigator.serviceWorker.ready;
    messaging = messaging || M.getMessaging(app);
    const token = await M.getToken(messaging, { vapidKey: self.FIREBASE_VAPID_KEY, serviceWorkerRegistration: reg });
    if(!token) throw new Error("sin token");
    await F.setDoc(dref("tokens", token), tokenData());
    store.set("multas.pushToken", token);
    toast("Notificaciones activadas en este móvil");
    listenForeground();
  }catch(e){ console.error(e); toast("No se pudieron activar las notificaciones."); }
  renderPush();
}
async function disablePush(){
  const tok=store.get("multas.pushToken","");
  try{ if(tok) await F.deleteDoc(dref("tokens", tok)); if(messaging && M) await M.deleteToken(messaging); }catch(e){ console.error(e); }
  store.set("multas.pushToken",""); toast("Notificaciones desactivadas"); renderPush();
}
let fgOn=false;
async function listenForeground(){
  if(fgOn || !(await pushSupported())) return; fgOn=true;
  messaging = messaging || M.getMessaging(app);
  // Con la app abierta ya avisamos con el aviso en pantalla; aquí solo el recordatorio del viernes.
  M.onMessage(messaging, p=>{ const t=p?.data?.tipo; if(t==="viernes"||t==="evento"||t==="aviso") toast((t==="evento"?(p.notification?.title||"")+": ":"")+(p.notification?.body||"")); });
}
function tokenData(){ return { equipo: TEAM, uid:S.user?.uid||"", jugador: myPlayer()?.id||"", solo_mias: !!(S.prefs.mine && myPlayer()), viernes: !!S.prefs.fri, creado: Date.now(), ios: isIOS }; }
async function syncTokenPrefs(){
  const tok=store.get("multas.pushToken","");
  if(!teamOpen) return;
  if(tok) try{ await F.setDoc(dref("tokens",tok), tokenData()); }catch{}
}

/* ---------- eventos ---------- */
document.addEventListener("click", e=>{
  const t=e.target.closest("button,[data-ficha]"); if(!t) return; if(t.tagName==="A") e.preventDefault();
  const d=t.dataset;
  if(t.id==="hideInstall"){ store.set("multas.hideInstall",true); renderInstall(); return; }
  if(t.id==="doInstall"&&installEvt){ installEvt.prompt(); installEvt.userChoice.finally(()=>{ installEvt=null; renderInstall(); }); return; }
  if(t.id==="claimBtn"){ const id=$("#claimSel")?.value; const p=playerById(id); if(!p){ toast("Elige tu nombre"); return; }
      run(()=>F.updateDoc(dref("jugadores",id),{email:email()}),"Cuenta vinculada: eres "+p.nombre); return; }
  if(t.id==="unclaim"){ const me=myPlayer(); if(me) armed(t,"¿Seguro?",()=>run(()=>F.updateDoc(dref("jugadores",me.id),{email:""}),"Cuenta desvinculada")); return; }
  if(t.id==="myHist"){ const me=myPlayer(); if(!me) return; renderHist(); $("#fPlayer").value=me.id; location.hash="historial"; renderHist(); return; }
  if(d.mail){ const box=document.querySelector(`[data-namebox="${CSS.escape(d.mail)}"]`); const p=playerById(d.mail); if(!box||!p) return;
      box.innerHTML=`<div class="row"><input type="text" id="ml-${esc(p.id)}" value="${esc(p.email||"")}" inputmode="email" autocapitalize="off" placeholder="correo@ejemplo.com" aria-label="Correo de ${esc(p.nombre)}" style="flex:1;min-width:150px"><button type="button" class="btn small" data-mailsave="${esc(p.id)}">Guardar</button></div><span class="note">Déjalo vacío para quitar la cuenta.</span>`;
      box.querySelector("input").focus(); return; }
  if(d.mailsave){ const v=document.getElementById("ml-"+d.mailsave).value.trim().toLowerCase();
      if(v && !/^\S+@\S+\.\S+$/.test(v)){ toast("Escribe un correo válido"); return; }
      const other=v && S.jug.find(p=>p.id!==d.mailsave && String(p.email||"").toLowerCase()===v);
      if(other){ toast("Ese correo ya es de "+other.nombre); return; }
      run(()=>F.updateDoc(dref("jugadores",d.mailsave),{email:v}), v?"Correo guardado":"Cuenta quitada"); return; }
  if(d.ay){ showAyuda(d.ay); return; }
  if(handleTanda1(t,d)) return;
  if(handleTanda2(t,d)) return;
  if(handleFanClick(t,d)) return;
  if(handlePlanClick(t,d)) return;
  if(handleScoutClick(t,d)) return;
  if(d.dia!==undefined){ t.setAttribute("aria-pressed", t.getAttribute("aria-pressed")!=="true"); return; }
  if(t.id==="diasSave"){ saveDias(); return; }
  if(t.id==="avMore"){ S.showAllAv=!S.showAllAv; renderAvisos(); return; }
  if(d.avdel){ armed(t,"¿Borrar? Toca otra vez",()=>run(()=>F.deleteDoc(F.doc(col(d.avcol||"avisos"),d.avdel)),"Aviso borrado")); return; }
  if(d.avpara){ S.avPara=d.avpara; const adm=d.avpara==="admins"; document.querySelectorAll("[data-avpara]").forEach(b=>b.setAttribute("aria-pressed",b.dataset.avpara===d.avpara));
    $("#avText").maxLength=adm?1500:300; $("#avLabel").textContent=adm?"Nuevo aviso solo para administradores":"Nuevo aviso para todo el equipo"; $("#avSend").textContent=adm?"Enviar a los administradores":"Enviar a todo el equipo";
    $("#avLeft").textContent=(adm?1500:300)-$("#avText").value.length; return; }
  if(t.id==="evMore"){ S.showAllPast=true; renderAsis(); return; }
  if(d.evopen){ S.openEv = S.openEv===d.evopen?null:d.evopen; renderAsis(); return; }
  if(d.rsvp){ const [id,v]=d.rsvp.split("|"); const ev=evById(id); const me=myPlayer(); if(!ev||!me) return;
      if(isClosed(ev)){ toast("El plazo para contestar ya se ha cerrado"); return; }
      const cur=confirmOf(ev,me); const nv = cur===v ? "" : v;
      if(nv==="no"){ const motivo=(document.getElementById("nt-"+id)?.value||"").trim().slice(0,80);
        if(!motivo){ toast("Escribe el motivo en el comentario y vuelve a pulsar «No voy»"); document.getElementById("nt-"+id)?.focus(); return; }
        run(()=>F.updateDoc(dref("eventos",id), new F.FieldPath("confirma",email()), "no", new F.FieldPath("notas",email()), motivo),"Apuntado: no vas"); return; }
      // Si era el «No voy» automático del día fijo y cambia de idea, se quita también el motivo (solo en este entreno)
      const nt=noteOf(ev,me); const fijo = nt && (nt===me.diasNota || nt==="Día fijo");
      const extra = (nv!=="no" && fijo) ? [new F.FieldPath("notas",email()), ""] : [];
      run(()=>F.updateDoc(dref("eventos",id), new F.FieldPath("confirma",email()), nv, ...extra), nv==="si"?(fijo?"Cambiado solo para este día: vas":"Apuntado: vas"):nv==="no"?"Apuntado: no vas":"Respuesta quitada"); return; }
  if(d.rsvpnote){ const id=d.rsvpnote; if(isClosed(evById(id)||{})){ toast("El plazo para contestar ya se ha cerrado"); return; } const v=(document.getElementById("nt-"+id)?.value||"").trim().slice(0,80);
      run(()=>F.updateDoc(dref("eventos",id), new F.FieldPath("notas",email()), v), v?"Comentario guardado":"Comentario quitado"); return; }
  if(d.evping){ run(()=>F.updateDoc(dref("eventos",d.evping),{avisar:true}),"Aviso enviado: llegará en unos minutos"); return; }
  if(d.att){ const [id,pid,v]=d.att.split("|"); const ev=evById(id); if(!ev) return;
      const cur=(ev.asistencia||{})[pid];
      run(()=>F.updateDoc(dref("eventos",id), new F.FieldPath("asistencia",pid), cur===v ? F.deleteField() : v)); return; }
  if(d.allin){ const ev=evById(d.allin); if(!ev) return; const a={...(ev.asistencia||{})};
      activePlayers().forEach(p=>{ if(!a[p.id]) a[p.id]="si"; });
      run(()=>F.updateDoc(dref("eventos",ev.id),{asistencia:a}),"Lista completada"); return; }
  if(d.evdel){ armed(t,"¿Borrar? Toca otra vez",()=>{ if(S.openEv===d.evdel) S.openEv=null; run(()=>F.deleteDoc(dref("eventos",d.evdel)),"Borrado"); }); return; }
  if(d.evfine){ armed(t,"¿Seguro? Toca otra vez",()=>fineAbsences(d.evfine)); return; }
  if(d.open){ openTeam(d.open); location.hash="resumen"; return; }
  if(t.id==="switchTeam"){ leaveTeam(); return; }
  if(t.id==="migrateBtn"){ migrateLegacy(); return; }
  if(t.id==="copyLink"){ copyText(teamLink(TEAM),"Enlace copiado"); return; }
  if(t.id==="copyInvite"){ copyText(inviteText(),"Invitación copiada. Pégala en el grupo"); return; }
  if(t.id==="copyBtn"){ copySummary(); return; }
  if(t.id==="tcNameSave"){ const v=$("#tcNameIn").value.trim(); if(!v){ toast("Escribe un nombre"); return; } run(()=>F.updateDoc(teamRef(),{nombre:v}),"Nombre guardado"); return; }
  if(t.id==="tcCrestDel"){ armed(t,"¿Quitar? Toca otra vez",()=>run(()=>F.updateDoc(teamRef(),{escudo:""}),"Escudo quitado")); return; }
  if(t.id==="cIn"){ run(()=>A.signInWithEmailAndPassword(auth,$("#cEmail").value.trim(),$("#cPass").value),"Has entrado"); return; }
  if(t.id==="cNew"){ run(()=>A.createUserWithEmailAndPassword(auth,$("#cEmail").value.trim(),$("#cPass").value),"Cuenta creada"); return; }
  if(t.id==="cOut"){ run(()=>A.signOut(auth),"Has salido"); return; }
  if(t.id==="seedBtn"){ t.disabled=true; seedTeam().finally(()=>{ t.disabled=false; }); return; }
  if(t.id==="lOut"){ run(()=>A.signOut(auth),"Has salido"); return; }
  if(d.rank!==undefined){ S.openRank = S.openRank===d.rank?null:d.rank; renderResumen(); return; }
  if(d.type!==undefined){ S.selType=d.type; renderAdd(); return; }
  if(d.player!==undefined){ S.selPlayers.has(d.player)?S.selPlayers.delete(d.player):S.selPlayers.add(d.player); t.setAttribute("aria-pressed",S.selPlayers.has(d.player)); updatePreview(); return; }
  if(d.pay){ const m=S.multas.find(x=>x.id===d.pay); if(m){ const b=F.writeBatch(db); b.update(dref("multas",m.id),{pagada:!m.pagada, pagadaEn:!m.pagada?Date.now():null}); logCambio(b,m.pagada?"descobro":"cobro",multaTxt(m)); run(()=>b.commit(), m.pagada?"Cobro deshecho":"Marcada como cobrada"); } return; }
  if(d.del){ armed(t,"¿Quitar? Toca otra vez",()=>{ const m=S.multas.find(x=>x.id===d.del); const b=F.writeBatch(db); b.delete(dref("multas",d.del)); if(m) logCambio(b,"quitar",multaTxt(m)); run(()=>b.commit(),"Multa quitada"); }); return; }
  if(d.payall){ armed(t,"Confirmar cobro",()=>{ const list=S.multas.filter(m=>m.jugador===d.payall&&!m.pagada&&inPeriod(m));
      const b=F.writeBatch(db); list.forEach(m=>b.update(dref("multas",m.id),{pagada:true,pagadaEn:Date.now()}));
      if(list.length) logCambio(b,"cobro",`${playerById(d.payall)?.nombre||""} · cobra todo · ${eur(list.reduce((a,m)=>a+(+m.importe||0),0))}`);
      run(()=>b.commit(),"Cobradas "+list.length+" multas"); }); return; }
  if(d.remove){ armed(t,"¿Quitar? Toca otra vez",()=>run(()=>F.updateDoc(dref("jugadores",d.remove),{activo:false}),"Quitado del equipo")); return; }
  if(d.restore){ run(()=>F.updateDoc(dref("jugadores",d.restore),{activo:true}),"De vuelta en el equipo"); return; }
  if(d.purge){ armed(t,"¿Eliminar? Toca otra vez",()=>run(()=>F.deleteDoc(dref("jugadores",d.purge)),"Persona eliminada")); return; }
  if(d.rename){ const box=document.querySelector(`[data-namebox="${CSS.escape(d.rename)}"]`); const p=playerById(d.rename); if(!box||!p) return;
      box.innerHTML=`<div class="row"><input type="text" class="dorin" id="rd-${esc(p.id)}" value="${esc(hasDor(p)?p.dorsal:"")}" maxlength="2" inputmode="numeric" placeholder="Nº" aria-label="Dorsal"><input type="text" id="rn-${esc(p.id)}" value="${esc(p.nombre)}" maxlength="40" aria-label="Nuevo nombre" style="flex:1;min-width:120px"><button type="button" class="btn small" data-rnsave="${esc(p.id)}">Guardar</button></div>`;
      box.querySelector("input").focus(); return; }
  if(d.rnsave){ const v=document.getElementById("rn-"+d.rnsave).value.trim(); if(!v){ toast("Escribe un nombre"); return; }
      const dv=(document.getElementById("rd-"+d.rnsave)?.value||"").replace(/\D/g,"").slice(0,2);
      run(()=>F.updateDoc(dref("jugadores",d.rnsave),{nombre:v.toUpperCase(), dorsal:dv||null}),"Guardado"); return; }
  if(d.tsave){ const id=d.tsave; const nombre=document.getElementById("tn-"+id).value.trim(); const precio=+document.getElementById("tp-"+id).value; const unidad=document.getElementById("tu-"+id).value;
      if(!nombre||!(precio>=0)){ toast("Pon un nombre y un precio válido"); return; }
      run(()=>F.updateDoc(dref("tipos",id),{nombre,precio,unidad}),"Tipo de multa guardado"); return; }
  if(d.tdel){ armed(t,"¿Borrar? Toca otra vez",()=>run(()=>F.deleteDoc(dref("tipos",d.tdel)),"Tipo de multa borrado")); return; }
  if(d.admadd){ run(()=>F.updateDoc(teamRef(),{admins:F.arrayUnion(d.admadd)}),"Ahora es administrador"); return; }
  if(d.admdel){ if(String(d.admdel).toLowerCase()===String(S.aj.propietario||"").toLowerCase()){ toast("El propietario no se puede quitar"); return; } armed(t,"¿Quitar? Toca otra vez",()=>run(()=>F.updateDoc(dref("ajustes","general"),{admins:F.arrayRemove(d.admdel)}),"Administrador quitado")); return; }
});
$("#qty").addEventListener("input",updatePreview);
$("#qtyMinus").addEventListener("click",()=>{ $("#qty").value=Math.max(1,getQty()-1); updatePreview(); });
$("#qtyPlus").addEventListener("click",()=>{ $("#qty").value=Math.min(99,getQty()+1); updatePreview(); });
$("#fPlayer").addEventListener("change",renderHist);
$("#fState").addEventListener("change",renderHist);
$("#fOld").addEventListener("change",renderHist);
$("#nLive").addEventListener("change",e=>{ S.prefs.live=e.target.checked; store.set("multas.prefs",S.prefs); });
$("#nMine").addEventListener("change",e=>{ S.prefs.mine=e.target.checked; store.set("multas.prefs",S.prefs); syncTokenPrefs(); });
$("#nFri").addEventListener("change",e=>{ S.prefs.fri=e.target.checked; store.set("multas.prefs",S.prefs); renderResumen(); syncTokenPrefs(); });
$("#fridayBtn").addEventListener("click",()=>{ const t=S.tipos.find(x=>/medio campo/i.test(x.nombre)); if(t) S.selType=t.id; S.selPlayers.clear(); location.hash="anadir"; renderAdd(); });
$("#plazoForm").addEventListener("submit",e=>{
  e.preventDefault();
  const aviso=Math.min(48,Math.max(1,Math.round(+$("#plAviso").value||8))), cierre=Math.min(24,Math.max(0,Math.round(+$("#plCierre").value||0)));
  if(cierre>=aviso){ toast("El plazo debe cerrarse después del recordatorio (menos horas antes)"); return; }
  const tipo=$("#plTipo").value; if($("#plActivo").checked && !tipo){ toast("Elige qué multa se pone"); return; }
  const activo=$("#plActivo").checked;
  const b=F.writeBatch(db);
  b.update(teamRef(),{plazo:{activo, aviso, cierre, tipo}});
  // Aplicar también a los entrenos ya creados que aún no han empezado
  let n=0;
  S.eventos.filter(ev=>ev.tipo==="entreno" && ev.hora && ev.fecha>=today() && !ev.plazoCerrado).forEach(ev=>{
    const start=new Date(ev.fecha+"T"+ev.hora).getTime(); if(start<=Date.now()) return;
    b.update(dref("eventos",ev.id), activo ? {cierre:calcCierre(ev.fecha, ev.hora, cierre), plazoTipo:tipo} : {cierre:F.deleteField(), plazoTipo:F.deleteField()}); n++;
  });
  run(()=>b.commit(),"Plazo guardado"+(n?" y aplicado a "+n+" entrenos próximos":"")).then(()=>document.activeElement?.blur());
});
$("#tcFri").addEventListener("change",e=>run(()=>F.updateDoc(teamRef(),{viernes:e.target.checked}),e.target.checked?"Recordatorio activado para todo el equipo":"Recordatorio desactivado"));
$("#tcFile").addEventListener("change",e=>{ const f=e.target.files?.[0]; if(f) setCrest(f); e.target.value=""; });
$("#pagoForm").addEventListener("submit",e=>{
  e.preventDefault();
  const pct=Math.round(+$("#pgPct").value), min=+$("#pgMin").value, fijo=+$("#pgFijo").value, tipo=$("#pgTipo").value;
  if(tipo==="pct" && !(pct>=1 && pct<=500)){ toast("Pon un porcentaje entre 1 y 500"); return; }
  if(tipo==="pct" && !(min>=0 && min<=100)){ toast("Pon un mínimo entre 0 y 100 €"); return; }
  if(tipo==="fijo" && !(fijo>=0.5 && fijo<=100)){ toast("Pon un recargo entre 0,50 y 100 €"); return; }
  run(()=>F.updateDoc(teamRef(),{pagos:{activo:$("#pgActivo").checked, tipo, pct:pct||50, min:isNaN(min)?1:min, fijo:fijo||2}}),"Pago de multas guardado").then(()=>document.activeElement?.blur());
});
$("#evTipo").addEventListener("change",()=>renderAsis());
["pgTipo","pgPct","pgMin","pgFijo"].forEach(id=>$("#"+id).addEventListener("input",pagoEjemplo));
$("#avText").addEventListener("input",()=>{ $("#avLeft").textContent=(S.avPara==="admins"?1500:300)-$("#avText").value.length; });
$("#avForm").addEventListener("submit",e=>{
  e.preventDefault();
  const texto=$("#avText").value.trim(); if(!texto){ toast("Escribe el aviso"); return; }
  const btn=$("#avSend"); btn.disabled=true;
  const adm=S.avPara==="admins";
  run(()=>F.addDoc(col(adm?"avisosAdmin":"avisos"),{texto, autor:S.user?.uid||"", autorNombre:myPlayer()?.nombre||email(), creado:Date.now(), notificada:false}),adm?"Aviso enviado a los administradores":"Aviso publicado. La notificación llegará en unos minutos")
    .then(ok=>{ btn.disabled=false; if(ok){ $("#avText").value=""; $("#avLeft").textContent=adm?"1500":"300"; } });
});
$("#evForm").addEventListener("submit",e=>{
  e.preventDefault();
  const fecha=$("#evFecha").value; if(!fecha){ toast("Elige la fecha"); return; }
  const rep=Math.max(1,+$("#evRep").value||1);
  const tipoEv=$("#evTipo").value, horaEv=$("#evHora").value||"";
  if(tipoEv==="entreno" && !horaEv){ toast("Pon la hora del entreno"); $("#evHora").focus(); return; }
  const pl=plazoCfg();
  const base={tipo:$("#evTipo").value, hora:$("#evHora").value||"", nota:$("#evNota").value.trim(), asistencia:{}, confirma:{}, notas:{}, creado:Date.now(), autor:S.user?.uid||""};
  if(tipoEv==="partido" && $("#evRival").value){ base.rival=$("#evRival").value; if(!base.nota) base.nota="contra "+(S.rivales.find(r=>r.id===base.rival)?.nombre||""); }
  const b=F.writeBatch(db); const [y,m,dd]=fecha.split("-").map(Number);
  for(let i=0;i<rep;i++){ const d=new Date(y,m-1,dd+7*i); const f=d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
    const extra={};
    if(pl.activo && tipoEv==="entreno" && horaEv){ extra.cierre = calcCierre(f, horaEv, pl.cierre); extra.plazoTipo = pl.tipo; }
    // Jugadores con ese día marcado como «no puedo»: No voy automático
    const conf={}, nts={}; const wd=d.getDay();
    if(tipoEv==="entreno") activePlayers().forEach(p=>{ if(p.email && (p.diasNo||[]).includes(wd)){ conf[pkey(p)]="no"; nts[pkey(p)]=p.diasNota||"Día fijo"; } });
    b.set(F.doc(col("eventos")),{...base, ...extra, confirma:conf, notas:nts, fecha:f, serie:i===0?rep:0, notificada:i>0}); }
  run(()=>b.commit(), rep>1 ? rep+" "+(base.tipo==="partido"?"partidos":"entrenos")+" creados (uno cada semana)" : (EV_TXT[base.tipo]||"Evento")+" creado").then(ok=>{ if(ok){ $("#evNota").value=""; $("#evRep").value="1"; } });
});
async function fineAbsences(id){
  const ev=evById(id); if(!ev) return;
  const tFalta=S.tipos.find(t=>/falta.*entreno/i.test(t.nombre)), tTarde=S.tipos.find(t=>/tarde.*entreno/i.test(t.nombre));
  const b=F.writeBatch(db); let n=0;
  activePlayers().forEach(p=>{
    const v=(ev.asistencia||{})[p.id]; const t = v==="no"?tFalta : v==="tarde"?tTarde : null; if(!t) return;
    b.set(F.doc(col("multas")),{jugador:p.id, jugadorNombre:p.nombre, tipo:t.id, tipoNombre:t.nombre, unidad:t.unidad||"fijo", precio:+t.precio, cantidad:1, importe:+t.precio, fecha:ev.fecha, nota:"Pasando lista", pagada:false, notificada:false, creado:Date.now(), autor:S.user?.uid||""}); n++;
  });
  if(!n){ toast("No hay tipos de multa «Falta al entreno» o «Tarde al entreno». Créalos en Ajustes."); return; }
  b.update(dref("eventos",id),{multado:true});
  run(()=>b.commit(), n===1?"1 multa puesta":n+" multas puestas");
}
$("#joinForm").addEventListener("submit",async e=>{
  e.preventDefault(); const id=cleanCode($("#joinCode").value); if(id.length<4){ toast("Escribe el código o pega el enlace del equipo"); return; }
  try{ const t=await F.getDoc(F.doc(db,"equipos",id)); if(!t.exists()){ toast("No existe ningún equipo con el código "+id); return; } }catch(err){ toast(errMsg(err)); return; }
  $("#joinCode").value=""; location.hash="resumen"; openTeam(id);
});
$("#createForm").addEventListener("submit",e=>{ e.preventDefault(); createTeam(); });
function copySummary(){
  const list=S.multas.filter(inPeriod); const by=new Map();
  list.forEach(m=>{ const n=playerById(m.jugador)?.nombre||m.jugadorNombre||"?"; const r=by.get(n)||{t:0,p:0}; r.t+=+m.importe||0; if(!m.pagada) r.p+=+m.importe||0; by.set(n,r); });
  const T=totals(list);
  const lines=["🏀 *MULTAS · "+(S.aj.nombre||"EQUIPO").toUpperCase()+"* 🏀"];
  if(S.aj.inicio) lines.push("Desde "+monthName(S.aj.inicio));
  lines.push(""); [...by.entries()].sort((a,b)=>b[1].t-a[1].t).forEach(([n,r])=>lines.push("*"+n+"*: "+eur(r.t)+(r.p>0?" (debe "+eur(r.p)+")":" ✅")));
  lines.push("","*Bote:* "+eur(T.t)+" · Por cobrar: "+eur(T.p)); if(S.aj.contador) lines.push("Conteo: "+S.aj.contador);
  copyText(lines.join("\n"),"Resumen copiado. Pégalo en el grupo");
}
$("#pushBtn").addEventListener("click",()=>{ $("#pushBtn").dataset.on ? disablePush() : enablePush(); });

$("#addForm").addEventListener("submit", e=>{
  e.preventDefault();
  const t=typeById(S.selType); const ids=[...S.selPlayers]; if(!t||!ids.length) return;
  const q=getQty(); const fecha=$("#fecha").value||today(); const nota=$("#nota").value.trim();
  const b=F.writeBatch(db);
  ids.forEach(id=>{ const p=playerById(id);
    b.set(F.doc(col("multas")),{jugador:id, jugadorNombre:p?.nombre||"", tipo:t.id, tipoNombre:t.nombre, unidad:t.unidad||"fijo", precio:+t.precio, cantidad:q, importe:(+t.precio)*q, fecha, nota, pagada:false, notificada:false, creado:Date.now(), autor:S.user?.uid||""});
    logCambio(b,"multa",`${p?.nombre||""} · ${t.nombre}${q>1?" ×"+q:""} · ${eur((+t.precio)*q)}`); });
  // El lote se guarda en el móvil al momento y se sube cuando hay red
  b.commit().catch(err=>{ console.error(err); toast(errMsg(err)); });
  toast(ids.length===1?"Multa puesta: "+eur((+t.precio)*q):ids.length+" multas puestas");
  S.selPlayers.clear(); $("#nota").value=""; $("#qty").value=1; renderAdd();
});

$("#playerForm").addEventListener("submit", async e=>{
  e.preventDefault();
  const nombre=$("#pName").value.trim().toUpperCase(); if(!nombre){ toast("Escribe el nombre"); return; }
  if(S.jug.some(p=>p.nombre===nombre && p.activo!==false)){ toast(nombre+" ya está en el equipo"); return; }
  const ok=await run(()=>F.addDoc(col("jugadores"),{nombre, rol:$("#pRole").value, activo:true, creado:Date.now()}), nombre+" añadido");
  if(ok) $("#pName").value="";
});
$("#periodForm").addEventListener("submit", e=>{
  e.preventDefault();
  run(()=>F.updateDoc(dref("ajustes","general"),{inicio:$("#inicio").value||"", contador:$("#contador").value.trim()}),"Conteo guardado");
});
$("#typeForm").addEventListener("submit", e=>{
  e.preventDefault();
  const nombre=$("#tName").value.trim(); const precio=+$("#tPrice").value;
  if(!nombre||!(precio>=0)){ toast("Pon un nombre y un precio válido"); return; }
  const orden=Math.max(0,...S.tipos.map(t=>t.orden||0))+1;
  run(()=>F.addDoc(col("tipos"),{nombre,precio,unidad:$("#tUnit").value,orden}),"Tipo de multa añadido").then(ok=>{ if(ok) $("#tName").value=""; });
});
$("#adminForm").addEventListener("submit", e=>{
  e.preventDefault();
  const v=$("#aEmail").value.trim().toLowerCase(); if(!/^\S+@\S+\.\S+$/.test(v)){ toast("Escribe un correo válido"); return; }
  run(()=>F.updateDoc(dref("ajustes","general"),{admins:F.arrayUnion(v)}),"Administrador añadido").then(ok=>{ if(ok) $("#aEmail").value=""; });
});
$("#loginForm").addEventListener("submit", e=>{
  e.preventDefault();
  run(()=>A.signInWithEmailAndPassword(auth,$("#lEmail").value.trim(),$("#lPass").value),"Has entrado");
});
$("#lNew").addEventListener("click",()=>{
  run(()=>A.createUserWithEmailAndPassword(auth,$("#lEmail").value.trim(),$("#lPass").value),"Cuenta creada");
});
$("#lForgot").addEventListener("click",()=>{
  const v=$("#lEmail").value.trim(); if(!v){ toast("Escribe tu correo arriba"); return; }
  run(()=>A.sendPasswordResetEmail(auth,v),"Te hemos enviado un correo para cambiarla");
});
async function seedTeam(){
  const b=F.writeBatch(db);
  DEFAULT_TYPES.forEach(([nombre,precio,unidad],i)=>b.set(dref("tipos","t"+(i+1)),{nombre,precio,unidad,orden:i+1}));
  return run(()=>b.commit(),"Multas de ejemplo añadidas");
}
addEventListener("hashchange",route);


/* ---------- manual de uso ---------- */
let ayTab="todos";
function showAyuda(t){ ayTab = (t==="admin" && S.canWrite) ? "admin" : "todos"; renderAyuda(); }
function renderAyuda(){
  if(!$("#v-ayuda")) return;
  if(!S.canWrite) ayTab="todos";        // la parte de administradores solo la ven ellos
  $("#ayTabAdmin").hidden=!S.canWrite;
  $("#ayTabTodos").setAttribute("aria-pressed", ayTab==="todos");
  $("#ayTabAdmin").setAttribute("aria-pressed", ayTab==="admin");
  $("#ayTodos").hidden = ayTab!=="todos";
  $("#ayAdmin").hidden = ayTab!=="admin";
}

/* ---------- días fijos de «No voy» ---------- */
const DIAS_ORD=[[1,"Lun"],[2,"Mar"],[3,"Mié"],[4,"Jue"],[5,"Vie"],[6,"Sáb"],[0,"Dom"]];
function renderDias(){
  const me=myPlayer(); const card=$("#diasCard"); if(!card) return;
  card.hidden=!me; if(!me) return;
  if(card.contains(document.activeElement)) return;
  const sel=me.diasNo||[];
  $("#diasSeg").innerHTML=DIAS_ORD.map(([n,l])=>`<button type="button" data-dia="${n}" data-v="no" aria-pressed="${sel.includes(n)}">${l}</button>`).join("");
  $("#diasNota").value=me.diasNota||"";
}
async function saveDias(){
  const me=myPlayer(); if(!me) return;
  const dias=[...document.querySelectorAll("#diasSeg [data-dia]")].filter(b=>b.getAttribute("aria-pressed")==="true").map(b=>+b.dataset.dia);
  const nota=$("#diasNota").value.trim().slice(0,60);
  if(!await run(()=>F.updateDoc(dref("jugadores",me.id),{diasNo:dias, diasNota:nota}))) return;
  // Aplicar a los entrenos ya creados en esos días a los que aún no he contestado
  const k=email(); let n=0;
  for(const ev of S.eventos.filter(ev=>ev.tipo==="entreno" && ev.fecha>=today() && !isClosed(ev) && dias.includes(new Date(ev.fecha+"T12:00").getDay()) && !(ev.confirma||{})[k])){
    try{ await F.updateDoc(dref("eventos",ev.id), new F.FieldPath("confirma",k), "no", new F.FieldPath("notas",k), nota||"Día fijo"); n++; }catch(e){ console.warn(e); }
  }
  toast(dias.length ? "Guardado"+(n?": «No voy» en "+n+" entrenos":"") : "Días fijos quitados");
}

/* ---------- pago de multas ---------- */
const pagosCfg = () => { const p=S.aj.pagos||{}; return {activo:!!p.activo, tipo:p.tipo==="fijo"?"fijo":"pct", pct:+p.pct||50, min:(p.min===undefined?1:+p.min), fijo:+p.fijo||2}; };
const recargoDe = (pg,deuda) => pg.tipo==="fijo" ? pg.fijo : Math.max(pg.min, Math.ceil(deuda*pg.pct/100*2)/2);
const recargoTxt = pg => pg.tipo==="fijo" ? `un recargo de ${eur(pg.fijo)}` : `un recargo del ${pg.pct} %`;
// Mes en que hay que pagar una multa: el de la multa, salvo las de la última semana, que pasan al siguiente
function mesCobro(fecha){ const d=new Date((fecha||today())+"T12:00"); d.setDate(d.getDate()+7); return d.getFullYear()+"-"+pad(d.getMonth()+1); }
function finDeMes(ym){ const [y,m]=ym.split("-").map(Number); return new Date(y,m,0); }
function pagoAviso(me){
  const pg=pagosCfg(); if(!pg.activo) return "";
  const pend=S.multas.filter(m=>m.jugador===me.id && !m.pagada);
  if(!pend.length) return "";
  const ym=today().slice(0,7);
  const ahora=pend.filter(m=>mesCobro(m.fecha)<=ym); const tot=ahora.reduce((a,m)=>a+(+m.importe||0),0);
  if(!tot) return `<p class="note">💶 Tienes multas del final de mes: se pagan el mes que viene.</p>`;
  const fin=finDeMes(ym).toLocaleDateString(LOC,{day:"numeric",month:"long"});
  return `<p class="note" style="color:var(--orange);font-weight:600">💶 Paga ${eur(tot)} antes del ${esc(fin)} o se aplicará ${recargoTxt(pg)} (${eur(recargoDe(pg,tot))}).</p>`;
}
function renderPagoCfg(){
  const pg=pagosCfg();
  $("#pgSummary").textContent = pg.activo ? `Activado: recordatorio una semana antes de fin de mes y, el día 1, ${pg.tipo==="fijo"?recargoTxt(pg):recargoTxt(pg)+" (mínimo "+eur(pg.min)+")"} a quien no haya pagado.` : "Desactivado: no hay recordatorio de pago ni recargo.";
  $("#pgEdit").hidden=!S.canWrite;
  if(S.canWrite && !$("#pagoForm").contains(document.activeElement)){ $("#pgActivo").checked=pg.activo; $("#pgTipo").value=pg.tipo; $("#pgPct").value=String(pg.pct); $("#pgMin").value=String(pg.min); $("#pgFijo").value=String(pg.fijo); }
  pagoEjemplo();
}
function pagoEjemplo(){
  const fijo=$("#pgTipo").value==="fijo";
  $("#pgPctRow").hidden=fijo; $("#pgFijoRow").hidden=!fijo;
  const pg={tipo:fijo?"fijo":"pct", pct:Math.max(1,+$("#pgPct").value||50), min:Math.max(0,+$("#pgMin").value||0), fijo:Math.max(0.5,+$("#pgFijo").value||2)};
  $("#pgEjemplo").textContent = "Ejemplo: "+[3,8,15].map(d=>`debe ${eur(d)} → recargo ${eur(recargoDe(pg,d))}`).join(" · ");
}

/* ---------- planes: encuestas y listas ---------- */
const planUnsubs=new Map();
const uid6=()=>Math.random().toString(36).slice(2,8);
const planById=id=>S.planes.find(p=>p.id===id);
const myName=()=>myPlayer()?.nombre||email();
const shortName=n=>{ const p=String(n||"?").split(/\s+/); const a=p[0]; return a.charAt(0)+a.slice(1).toLowerCase()+(p[1]?" "+p[1].charAt(0)+".":""); };
function syncPlanListeners(){
  const want=new Set(S.planes.filter(p=>!p.cerrado||p.id===S.openPlan).slice(0,10).map(p=>p.id));
  if(S.openPlan) want.add(S.openPlan);
  for(const [id,u] of planUnsubs){ if(!want.has(id)){ u(); planUnsubs.delete(id); } }
  want.forEach(id=>{
    if(planUnsubs.has(id)) return;
    const u1=F.onSnapshot(F.collection(db,"equipos",TEAM,"planes",id,"respuestas"),s=>{ S.planResp[id]=s.docs.map(d=>({id:d.id,...d.data()})); renderPlanes(); },e=>console.warn(e));
    const u2=F.onSnapshot(F.collection(db,"equipos",TEAM,"planes",id,"propuestas"),s=>{ S.planProp[id]=s.docs.map(d=>({id:d.id,...d.data()})); renderPlanes(); },e=>console.warn(e));
    planUnsubs.set(id,()=>{u1();u2();});
  });
}
const respRef=pid=>F.doc(db,"equipos",TEAM,"planes",pid,"respuestas",email());
function myResp(pid){ return (S.planResp[pid]||[]).find(r=>r.id===email())||{}; }
function renderPlanes(){
  const el=$("#planList"); if(!el) return;
  $("#planForm").hidden=!S.canWrite;
  const box=document.activeElement; if(box && el.contains(box) && box.tagName==="INPUT") return; // no borrar lo que se está escribiendo
  const list=[...S.planes].sort((a,b)=>(a.cerrado?1:0)-(b.cerrado?1:0)||(b.creado||0)-(a.creado||0));
  if(!list.length){ el.innerHTML='<li class="empty"><b>Ningún plan todavía</b>'+(S.canWrite?"Crea el primero arriba: una cena, la lotería…":"Cuando un administrador cree un plan, aparecerá aquí.")+'</li>'; return; }
  el.innerHTML=list.map(planCard).join("");
}
function planCard(p){
  const resp=S.planResp[p.id]||[], prop=S.planProp[p.id]||[], mine=myResp(p.id), canAns=!!email() && !p.cerrado;
  const bloques=Object.entries(p.bloques||{}).map(([id,b])=>({id,...b})).sort((a,b)=>(a.orden||0)-(b.orden||0));
  let h=`<li class="plan ${p.cerrado?"cerrado":""}"><header><span><b>${esc(p.titulo)}</b><br><span class="mini">${p.fecha?esc(dayName(p.fecha))+" · ":""}${resp.length} ${resp.length===1?"persona ha":"personas han"} respondido${p.cerrado?" · cerrado":""}</span></span>
    ${S.canWrite?`<span class="row"><button type="button" class="btn small ghost" data-plclose="${esc(p.id)}">${p.cerrado?"Reabrir":"Cerrar"}</button><button type="button" class="btn small danger" data-pldel="${esc(p.id)}">Borrar</button></span>`:""}</header>`;
  if(p.descripcion) h+=`<p class="note" style="margin:0;white-space:pre-wrap">${esc(p.descripcion)}</p>`;
  if(!email()) h+=`<span class="note">Entra con tu cuenta en Ajustes para votar y apuntarte.</span>`;
  bloques.forEach(b=>{
    h+=`<div class="bloque"><div class="who-line"><h4>${b.tipo==="lista"?"📝":"🗳️"} ${esc(b.titulo)}</h4>${S.canWrite?`<button type="button" class="btn small danger" data-bldel="${esc(p.id)}|${esc(b.id)}">Quitar</button>`:""}</div>`;
    if(b.tipo==="encuesta"){
      const opts=Object.entries(b.opciones||{}).map(([id,o])=>({id,texto:o.texto,orden:o.orden||0,fija:true}))
        .concat(prop.filter(x=>x.bloque===b.id).map(x=>({id:"p_"+x.id,texto:x.texto,orden:1e12+(x.creado||0),autor:x.autor,nombre:x.nombre,pid:x.id})))
        .sort((a,c)=>a.orden-c.orden);
      const votes=id=>resp.filter(r=>((r.votos||{})[b.id]||[]).includes(id));
      const max=Math.max(1,...opts.map(o=>votes(o.id).length));
      const myV=(mine.votos||{})[b.id]||[];
      h+=`<span class="mini">${b.multiple?"Puedes elegir varias":"Elige una"}</span>`;
      h+=opts.map(o=>{ const v=votes(o.id); return `<button type="button" class="opt" data-vote="${esc(p.id)}|${esc(b.id)}|${esc(o.id)}" aria-pressed="${myV.includes(o.id)}" ${canAns?"":"disabled"}>
        <span>${esc(o.texto)}${o.nombre?` <span class="mini">· propuesta de ${esc(shortName(o.nombre))}</span>`:""}</span><span class="n">${v.length}</span>
        <span class="bar"><i style="width:${(v.length/max*100).toFixed(0)}%"></i></span>
        ${v.length?`<span class="who">${v.map(r=>esc(shortName(r.nombre))).join(", ")}</span>`:""}</button>
        ${o.pid&&(S.canWrite||o.autor===email())?`<button type="button" class="btn small ghost" data-propdel="${esc(p.id)}|${esc(o.pid)}" style="align-self:flex-end">Quitar propuesta</button>`:""}`; }).join("");
      if(b.abiertas && canAns) h+=`<div class="inl"><input type="text" id="np-${esc(p.id)}-${esc(b.id)}" maxlength="80" placeholder="Proponer otra opción"><button type="button" class="btn small" data-propadd="${esc(p.id)}|${esc(b.id)}">Añadir</button></div>`;
    } else {
      const ins=resp.filter(r=>(r.listas||{})[b.id]?.si);
      const my=(mine.listas||{})[b.id]||{};
      const total=ins.reduce((a,r)=>a+(+(r.listas[b.id].cantidad)||1),0);
      h+=`<span class="mini">${ins.length} apuntados${b.cantidad?` · ${total} ${esc(b.unidad||"en total")}`:""}</span>`;
      if(ins.length) h+=`<div class="mini" style="color:var(--ink)">${ins.map(r=>{ const x=r.listas[b.id]; return `<div>• <b>${esc(shortName(r.nombre))}</b>${b.cantidad?` × ${+x.cantidad||1}`:""}${x.nota?` — ${esc(x.nota)}`:""}</div>`; }).join("")}</div>`;
      if(canAns) h+=`<div class="inl">${b.cantidad?`<input type="number" id="lq-${esc(p.id)}-${esc(b.id)}" min="1" max="99" value="${+my.cantidad||1}" aria-label="Cantidad">`:""}
        <input type="text" id="ln-${esc(p.id)}-${esc(b.id)}" maxlength="80" value="${esc(my.nota||"")}" placeholder="${esc(b.pista||"Comentario (opcional)")}">
        <button type="button" class="btn small ${my.si?"ghost":""}" data-lst="${esc(p.id)}|${esc(b.id)}|1">${my.si?"Guardar":"Apuntarme"}</button>
        ${my.si?`<button type="button" class="btn small danger" data-lst="${esc(p.id)}|${esc(b.id)}|0">Desapuntarme</button>`:""}</div>`;
    }
    h+="</div>";
  });
  if(S.canWrite && !p.cerrado){
    const open=S.openPlan===p.id;
    h+=`<div class="bloque"><div class="row"><button type="button" class="btn small" data-pladd="${esc(p.id)}|encuesta">+ Encuesta</button><button type="button" class="btn small ghost" data-pladd="${esc(p.id)}|lista">+ Lista</button></div>`;
    if(open && S.addKind==="encuesta") h+=`<div class="stack">
      <div class="row">${["📍 Lugar","📅 Día","🕘 Hora"].map(x=>`<button type="button" class="btn small ghost" data-preset="${esc(x)}">${x}</button>`).join("")}</div>
      <label class="f">Pregunta<input type="text" id="bq-titulo" maxlength="80" placeholder="Ej.: ¿Dónde cenamos?"></label>
      <label class="f">Opciones (una por línea)<textarea id="bq-opts" rows="4" placeholder="Ej.:&#10;Pizzería Napoli&#10;Bar Central"></textarea></label>
      <label class="switch note"><span>Se pueden elegir varias</span><input type="checkbox" id="bq-multi"></label>
      <label class="switch note"><span>Cualquiera puede proponer opciones</span><input type="checkbox" id="bq-open" checked></label>
      <button type="button" class="btn small" data-blsave="${esc(p.id)}|encuesta">Añadir encuesta</button></div>`;
    if(open && S.addKind==="lista") h+=`<div class="stack">
      <label class="f">Título<input type="text" id="bq-titulo" maxlength="80" placeholder="Ej.: Apúntate a la cena · Lotería de Navidad"></label>
      <label class="switch note"><span>Pedir cantidad (décimos, invitados…)</span><input type="checkbox" id="bq-cant"></label>
      <label class="f">Qué se cuenta (si pides cantidad)<input type="text" id="bq-unidad" maxlength="30" placeholder="Ej.: décimos"></label>
      <label class="f">Texto de ayuda para el comentario<input type="text" id="bq-pista" maxlength="60" placeholder="Ej.: alergias, menú vegetariano…"></label>
      <button type="button" class="btn small" data-blsave="${esc(p.id)}|lista">Añadir lista</button></div>`;
    h+="</div>";
  }
  return h+"</li>";
}
function handlePlanClick(t,d){
  if(d.plclose){ const p=planById(d.plclose); run(()=>F.updateDoc(F.doc(col("planes"),d.plclose),{cerrado:!p?.cerrado}),p?.cerrado?"Plan reabierto":"Plan cerrado"); return true; }
  if(d.pldel){ armed(t,"¿Borrar? Toca otra vez",()=>run(()=>F.deleteDoc(F.doc(col("planes"),d.pldel)),"Plan borrado")); return true; }
  if(d.pladd){ const [pid,k]=d.pladd.split("|"); S.addKind = (S.openPlan===pid && S.addKind===k) ? null : k; S.openPlan=pid; syncPlanListeners(); renderPlanes(); return true; }
  if(d.preset!==undefined){ const m={"📍 Lugar":"¿Dónde vamos?","📅 Día":"¿Qué día?","🕘 Hora":"¿A qué hora?"}; const i=$("#bq-titulo"); if(i) i.value=m[d.preset]||""; return true; }
  if(d.blsave){
    const [pid,k]=d.blsave.split("|"); const titulo=($("#bq-titulo")?.value||"").trim(); if(!titulo){ toast("Escribe el título"); return true; }
    const p=planById(pid); const orden=Object.keys(p?.bloques||{}).length+1; const bid=uid6(); let blk;
    if(k==="encuesta"){
      const opts=($("#bq-opts").value||"").split("\n").map(x=>x.trim()).filter(Boolean).slice(0,20);
      if(!opts.length && !$("#bq-open").checked){ toast("Pon al menos una opción"); return true; }
      blk={tipo:"encuesta", titulo, orden, multiple:$("#bq-multi").checked, abiertas:$("#bq-open").checked, opciones:Object.fromEntries(opts.map((o,i)=>[uid6(),{texto:o.slice(0,80),orden:i}]))};
    } else blk={tipo:"lista", titulo, orden, cantidad:$("#bq-cant").checked, unidad:($("#bq-unidad").value||"").trim(), pista:($("#bq-pista").value||"").trim()};
    run(()=>F.updateDoc(F.doc(col("planes"),pid), new F.FieldPath("bloques",bid), blk), k==="encuesta"?"Encuesta añadida":"Lista añadida").then(ok=>{ if(ok){ S.addKind=null; renderPlanes(); } });
    return true;
  }
  if(d.bldel){ const [pid,bid]=d.bldel.split("|"); armed(t,"¿Quitar? Toca otra vez",()=>run(()=>F.updateDoc(F.doc(col("planes"),pid), new F.FieldPath("bloques",bid), F.deleteField()),"Quitado")); return true; }
  if(d.vote){
    const [pid,bid,oid]=d.vote.split("|"); const p=planById(pid); const b=p?.bloques?.[bid]; if(!b||p.cerrado) return true;
    const cur=((myResp(pid).votos||{})[bid])||[];
    const next = cur.includes(oid) ? cur.filter(x=>x!==oid) : (b.multiple ? [...cur,oid] : [oid]);
    run(()=>F.setDoc(respRef(pid),{nombre:myName(), votos:{[bid]:next}, actualizado:Date.now()},{merge:true}));
    return true;
  }
  if(d.propadd){
    const [pid,bid]=d.propadd.split("|"); const i=document.getElementById(`np-${pid}-${bid}`); const v=(i?.value||"").trim().slice(0,80); if(!v){ toast("Escribe tu propuesta"); return true; }
    i.value=""; i.blur();
    run(()=>F.addDoc(F.collection(db,"equipos",TEAM,"planes",pid,"propuestas"),{bloque:bid, texto:v, autor:email(), nombre:myName(), creado:Date.now()}),"Propuesta añadida");
    return true;
  }
  if(d.propdel){ const [pid,id]=d.propdel.split("|"); run(()=>F.deleteDoc(F.doc(db,"equipos",TEAM,"planes",pid,"propuestas",id)),"Propuesta quitada"); return true; }
  if(d.lst){
    const [pid,bid,si]=d.lst.split("|"); const q=document.getElementById(`lq-${pid}-${bid}`), n=document.getElementById(`ln-${pid}-${bid}`);
    const val= si==="1" ? {si:true, cantidad:Math.max(1,Math.min(99,+(q?.value)||1)), nota:(n?.value||"").trim().slice(0,80)} : {si:false};
    document.activeElement?.blur();
    run(()=>F.setDoc(respRef(pid),{nombre:myName(), listas:{[bid]:val}, actualizado:Date.now()},{merge:true}), si==="1"?"Apuntado":"Desapuntado");
    return true;
  }
  return false;
}
$("#planForm").addEventListener("submit",e=>{
  e.preventDefault();
  const titulo=$("#plTitulo").value.trim(); if(!titulo){ toast("Pon un título"); return; }
  run(()=>F.addDoc(col("planes"),{titulo, descripcion:$("#plDesc").value.trim(), fecha:$("#plFecha").value||"", bloques:{}, cerrado:false, notificada:false, creado:Date.now(), autor:S.user?.uid||"", autorNombre:myName()}),"Plan creado. Ahora añade encuestas o listas")
    .then(ok=>{ if(ok){ $("#plTitulo").value=""; $("#plDesc").value=""; $("#plFecha").value=""; } });
});

/* ---------- scouting de rivales ---------- */
let rivUnsub=null;
function openRival(id){
  if(S.rivalOpen===id && rivUnsub) return;
  S.dorsalMode=false; S.rjEdit=null;
  if(rivUnsub){ rivUnsub(); rivUnsub=null; }
  S.rivalOpen=id; S.rivNotas=[];
  if(id) rivUnsub=F.onSnapshot(F.collection(db,"equipos",TEAM,"rivales",id,"notas"),s=>{ S.rivNotas=s.docs.map(d=>({id:d.id,...d.data()})); renderScouting(); },e=>console.warn(e));
  renderScouting();
}
function renderScouting(){
  const box=$("#rivBox"); if(!box) return;
  $("#rivNew").hidden=!S.canWrite; $("#fbcvCard").hidden=!S.canWrite;
  const rs=[...S.rivales].sort((a,b)=>(a.nombre||"").localeCompare(b.nombre||"","es"));
  const sel=$("#rivSel");
  sel.innerHTML='<option value="">— Elige rival —</option>'+rs.map(r=>`<option value="${esc(r.id)}">${esc(r.nombre)}</option>`).join("");
  sel.value=S.rivalOpen||"";
  // Fila de rivales: primero el del próximo partido
  const prox=id=>S.eventos.filter(ev=>ev.tipo==="partido" && ev.rival===id && ev.fecha>=today()).sort((a,b)=>a.fecha.localeCompare(b.fecha))[0];
  const ord=[...rs].sort((a,b)=>{ const pa=prox(a.id), pb=prox(b.id); return (pa?pa.fecha:"9")<(pb?pb.fecha:"9")?-1:(pa?pa.fecha:"9")>(pb?pb.fecha:"9")?1:(a.nombre||"").localeCompare(b.nombre||""); });
  const corto=n=>String(n||"").replace(/^(C\.?B\.?|CB|CLUB)\s+/i,"").replace(/\s*-\s*.*$/,"").slice(0,22);
  $("#rivChips").innerHTML=ord.map(x=>{ const p=prox(x.id); const casa=p&&/en casa/i.test(p.nota||"");
    return `<button type="button" class="rivchip" role="tab" aria-pressed="${x.id===S.rivalOpen}" data-riv="${esc(x.id)}"><b>${esc(corto(x.nombre))}</b><span>${p?esc(new Date(p.fecha+"T12:00").toLocaleDateString(LOC,{weekday:"short",day:"numeric",month:"short"}))+(p.nota?(casa?" · 🏠":" · ✈️"):""):"sin partido"}</span></button>`; }).join("");
  // selector en el formulario de partido
  const er=$("#evRival"); if(er){ const cur=er.value; er.innerHTML='<option value="">— Sin rival —</option>'+rs.map(r=>`<option value="${esc(r.id)}">${esc(r.nombre)}</option>`).join(""); er.value=cur; $("#evRivalWrap").hidden=$("#evTipo").value!=="partido"; }
  if(box.contains(document.activeElement) && document.activeElement.tagName!=="BUTTON") return;
  // Sin rival elegido: el del próximo partido
  if(!S.rivalOpen && rs.length){
    const nx=S.eventos.filter(ev=>ev.tipo==="partido" && ev.rival && ev.fecha>=today() && rs.some(x=>x.id===ev.rival)).sort((a,b)=>a.fecha.localeCompare(b.fecha))[0];
    if(nx){ openRival(nx.rival); return; }
  }
  const r=rs.find(x=>x.id===S.rivalOpen);
  if(!r){ box.innerHTML = rs.length ? '<p class="note">Elige un rival para ver su plantilla y las notas.</p>' : '<div class="empty"><b>Sin rivales</b>'+(S.canWrite?"Añade el primero arriba.":"Cuando un administrador añada rivales, aparecerán aquí.")+'</div>'; return; }
  const dn=j=>(j.dorsal===null||j.dorsal===undefined||j.dorsal==="")?999:+j.dorsal;
  const plantilla=Object.entries(r.plantilla||{}).map(([id,j])=>({id,...j})).sort((a,b)=>dn(a)-dn(b)||(a.nombre||"").localeCompare(b.nombre||""));
  const notasDe=pid=>S.rivNotas.filter(n=>(n.jugador||"")===pid).sort((a,b)=>(a.creado||0)-(b.creado||0));
  const partidos=S.eventos.filter(ev=>ev.rival===r.id).sort((a,b)=>(a.fecha||"").localeCompare(b.fecha||""));
  const notaHtml=n=>`<div class="nota"><p>${esc(n.texto)}<br><span class="mini">${esc(shortName(n.nombre))} · ${esc(haceCuanto(n.creado||0))}</span></p>${S.canWrite||n.autor===email()?`<button type="button" class="btn small ghost" data-notadel="${esc(n.id)}">✕</button>`:""}</div>`;
  const addNota=pid=>email()?`<div class="inl"><input type="text" id="rn-${esc(pid||"gen")}" maxlength="500" placeholder="${pid?"Tira bien de 3, zurdo, defiende flojo…":"Defensa zonal, juegan rápido…"}"><button type="button" class="btn small" data-notaadd="${esc(pid||"")}">Añadir</button></div>`:"";
  const posCorta=p=>{ const m=String(p||"").match(/\(([^)]+)\)/); return m?m[1]:(p||""); };
  const conNotas=plantilla.filter(j=>notasDe(j.id).length), sinNotas=plantilla.filter(j=>!notasDe(j.id).length);
  const gen=notasDe("");
  let h=`<div class="card resumen-sc"><div class="who-line"><h3>📋 Resumen · ${esc(r.nombre)}</h3><span class="mini">${S.rivNotas.length} notas</span></div>
    ${gen.length?`<div class="sc-gen">🏀 ${gen.map(n=>esc(n.texto)).join(" · ")}</div>`:""}
    ${conNotas.length?`<div class="tblwrap"><table class="sc-tbl"><thead><tr><th>Nº</th><th>Jugador</th><th>Pos</th><th>Pts</th><th>Scouting</th></tr></thead><tbody>`+
      conNotas.map(j=>`<tr><td><span class="dor sm">${esc(j.dorsal??"–")}</span></td><td><b>${esc(shortName(j.nombre))}</b></td><td>${esc(posCorta(j.pos))}</td><td>${statsRival(r.id,j.nombre)?.pts??"–"}</td><td>${notasDe(j.id).map(n=>esc(n.texto)).join(" · ")}</td></tr>`).join("")+
      `</tbody></table></div>`:'<p class="note">Todavía no hay notas de jugadores. Añadidlas abajo, en cada jugador.</p>'}
    ${sinNotas.length?`<p class="mini">Sin notas: ${sinNotas.map(j=>(j.dorsal!=null&&j.dorsal!==""?"#"+esc(j.dorsal)+" ":"")+esc(shortName(j.nombre))).join(", ")}</p>`:""}
  </div>`;
  h+=`<div class="card"><div class="who-line"><h3>${esc(r.nombre)}</h3>${S.canWrite?`<button type="button" class="btn small danger" data-rivdel="${esc(r.id)}">Borrar rival</button>`:""}</div>
    ${partidos.length?`<span class="note">Partidos: ${partidos.map(p=>esc(dayName(p.fecha))).join(" · ")}</span>`:""}
    <h4 style="margin:4px 0 0">Notas generales del equipo</h4>${notasDe("").map(notaHtml).join("")||'<span class="mini">Sin notas todavía.</span>'}${addNota("")}</div>`;
  h+=`<div class="who-line"><h3>Plantilla (${plantilla.length})</h3>${S.canWrite&&plantilla.length?`<button type="button" class="btn small ${S.dorsalMode?"":"ghost"}" id="dorMode">${S.dorsalMode?"Cancelar":"🔢 Poner dorsales"}</button>`:""}</div>`;
  if(S.dorsalMode){
    h+=`<div class="card"><p class="note">Escribe el dorsal de cada jugador (déjalo vacío si no lo sabes) y pulsa Guardar.</p>`+
      plantilla.map(j=>`<div class="inl"><input type="number" class="dorin" id="dn-${esc(j.id)}" min="0" max="99" value="${j.dorsal??""}" aria-label="Dorsal de ${esc(j.nombre)}"><b style="flex:1">${esc(j.nombre)}</b></div>`).join("")+
      `<button type="button" class="btn" id="dorSave">Guardar dorsales</button></div>`;
    box.innerHTML=h; return;
  }
  if(S.canWrite) h+=`<div class="card"><div class="inl"><input type="number" id="rj-dorsal" min="0" max="99" placeholder="Nº" aria-label="Dorsal"><input type="text" id="rj-nombre" maxlength="50" placeholder="Nombre del jugador"><input type="text" id="rj-pos" maxlength="20" placeholder="Posición (opcional)" style="flex:0 1 140px"><button type="button" class="btn small" id="rjAdd">Añadir jugador</button></div></div>`;
  h+=plantilla.map(j=>`<div class="rj"><div class="who-line"><span class="row" style="gap:8px;flex-wrap:nowrap"><span class="dor">${esc(j.dorsal??"–")}</span><span><b>${esc(j.nombre)}</b>${j.pos?`<br><span class="mini">${esc(j.pos)}</span>`:""}${statsRival(r.id,j.nombre)?"<br>"+statTxt(statsRival(r.id,j.nombre)):""}</span></span>${S.canWrite?`<span class="row"><button type="button" class="btn small ghost" data-rjedit="${esc(j.id)}" aria-label="Editar">✏️</button><button type="button" class="btn small ghost" data-rjdel="${esc(j.id)}">Quitar</button></span>`:""}</div>
    ${S.rjEdit===j.id?`<div class="inl"><input type="number" class="dorin" id="re-d" min="0" max="99" value="${j.dorsal??""}" placeholder="Nº" aria-label="Dorsal"><input type="text" id="re-n" maxlength="50" value="${esc(j.nombre)}" aria-label="Nombre"><input type="text" id="re-p" maxlength="20" value="${esc(j.pos||"")}" placeholder="Posición" aria-label="Posición" style="flex:0 1 120px"><button type="button" class="btn small" data-rjsave="${esc(j.id)}">Guardar</button></div>`:""}
    ${notasDe(j.id).map(notaHtml).join("")}${addNota(j.id)}</div>`).join("") || '<p class="note">Todavía no hay jugadores en la plantilla.</p>';
  box.innerHTML=h;
}
function handleScoutClick(t,d){
  if(d.scout){ openRival(d.scout); location.hash="scouting"; return true; }
  if(d.riv){ openRival(d.riv); return true; }
  if(d.notaadd!==undefined){ const pid=d.notaadd; const i=document.getElementById("rn-"+(pid||"gen")); const v=(i?.value||"").trim(); if(!v){ toast("Escribe la nota"); return true; }
    i.value=""; i.blur();
    run(()=>F.addDoc(F.collection(db,"equipos",TEAM,"rivales",S.rivalOpen,"notas"),{jugador:pid, texto:v.slice(0,500), autor:email(), nombre:myName(), creado:Date.now(), notificada:false}),"Nota añadida. Se avisará al equipo"); return true; }
  if(d.notadel){ run(()=>F.deleteDoc(F.doc(db,"equipos",TEAM,"rivales",S.rivalOpen,"notas",d.notadel)),"Nota borrada"); return true; }
  if(t.id==="fbcvBtn"){ importFBCV(); return true; }
  if(t.id==="prepBtn"){ importPreparado(); return true; }
  if(t.id==="dorMode"){ S.dorsalMode=!S.dorsalMode; S.rjEdit=null; renderScouting(); return true; }
  if(t.id==="dorSave"){
    const r=S.rivales.find(x=>x.id===S.rivalOpen); if(!r) return true;
    const args=[]; Object.entries(r.plantilla||{}).forEach(([id,j])=>{ const i=document.getElementById("dn-"+id); if(!i) return;
      const v=i.value===""?null:Math.max(0,Math.min(99,Math.round(+i.value))); if(v!==(j.dorsal??null)) args.push(new F.FieldPath("plantilla",id,"dorsal"), v); });
    if(!args.length){ S.dorsalMode=false; renderScouting(); toast("No había cambios"); return true; }
    document.activeElement?.blur();
    run(()=>F.updateDoc(F.doc(col("rivales"),S.rivalOpen), ...args), "Dorsales guardados").then(ok=>{ if(ok){ S.dorsalMode=false; renderScouting(); } });
    return true; }
  if(d.rjedit){ S.rjEdit = S.rjEdit===d.rjedit ? null : d.rjedit; renderScouting(); return true; }
  if(d.rjsave){ const nombre=$("#re-n").value.trim().toUpperCase(); if(!nombre){ toast("Escribe el nombre"); return true; }
    const dorsal=$("#re-d").value===""?null:Math.max(0,Math.min(99,Math.round(+$("#re-d").value)));
    document.activeElement?.blur();
    run(()=>F.updateDoc(F.doc(col("rivales"),S.rivalOpen), new F.FieldPath("plantilla",d.rjsave), {nombre, dorsal, pos:$("#re-p").value.trim()}),"Jugador actualizado").then(ok=>{ if(ok){ S.rjEdit=null; renderScouting(); } });
    return true; }
  if(t.id==="rjAdd"){ const nombre=$("#rj-nombre").value.trim().toUpperCase(); if(!nombre){ toast("Escribe el nombre"); return true; }
    const dorsal=$("#rj-dorsal").value===""?null:+$("#rj-dorsal").value;
    run(()=>F.updateDoc(F.doc(col("rivales"),S.rivalOpen), new F.FieldPath("plantilla",uid6()), {nombre, dorsal, pos:$("#rj-pos").value.trim()}),"Jugador añadido")
      .then(ok=>{ if(ok){ $("#rj-nombre").value=""; $("#rj-dorsal").value=""; $("#rj-pos").value=""; } }); return true; }
  if(d.rjdel){ armed(t,"¿Quitar?",()=>run(()=>F.updateDoc(F.doc(col("rivales"),S.rivalOpen), new F.FieldPath("plantilla",d.rjdel), F.deleteField()),"Jugador quitado")); return true; }
  if(d.rivdel){ armed(t,"¿Borrar? Toca otra vez",()=>run(()=>F.deleteDoc(F.doc(col("rivales"),d.rivdel)),"Rival borrado").then(()=>openRival(""))); return true; }
  return false;
}
$("#rivSel").addEventListener("change",e=>openRival(e.target.value));
// Scouting preparado (notas, posiciones y jugadores que faltan), desde docs/scouting-preparado.json
async function importPreparado(){
  const btn=$("#prepBtn"); btn.disabled=true;
  try{
    const data=await (await fetch("scouting-preparado.json",{cache:"no-cache"})).json();
    const key=n=>String(n||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().replace(/[.\s]+/g," ").trim();
    let nn=0, np=0, nu=0;
    for(const [rid,info] of Object.entries(data)){
      const r=S.rivales.find(x=>x.id===rid); if(!r){ toast("Primero importa los rivales de la FBCV"); continue; }
      const ya=Object.entries(r.plantilla||{}).map(([pid,j])=>({pid,...j}));
      const existentes=(await F.getDocs(F.collection(db,"equipos",TEAM,"rivales",rid,"notas"))).docs.map(d=>d.data());
      const b=F.writeBatch(db); const args=[];
      for(const j of info.jugadores){
        let p=ya.find(x=>key(x.nombre)===key(j.nombre)||(j.alias&&key(x.nombre)===key(j.alias)));
        let pid=p?.pid;
        if(!p){ pid=uid6(); args.push(new F.FieldPath("plantilla",pid),{nombre:j.nombre, dorsal:j.dorsal??null, pos:j.pos||""}); np++; }
        else{
          if(j.pos && p.pos!==j.pos){ args.push(new F.FieldPath("plantilla",pid,"pos"), j.pos); nu++; }
          if(j.dorsal!=null && (p.dorsal===null||p.dorsal===undefined||p.dorsal==="")){ args.push(new F.FieldPath("plantilla",pid,"dorsal"), j.dorsal); nu++; }
        }
        if(j.nota && !existentes.some(n=>n.jugador===pid && n.texto===j.nota)){
          b.set(F.doc(F.collection(db,"equipos",TEAM,"rivales",rid,"notas")),{jugador:pid, texto:j.nota, autor:email(), nombre:myName(), creado:Date.now(), notificada:false}); nn++;
        }
      }
      if(args.length) b.update(F.doc(col("rivales"),rid), ...args);
      if(args.length||nn) await b.commit();
    }
    toast(nn||np||nu ? `Cargado: ${nn} notas, ${np} jugadores nuevos, ${nu} posiciones/dorsales` : "Ya estaba todo cargado");
  }catch(e){ console.error(e); toast("No se pudo cargar: "+errMsg(e)); }
  finally{ btn.disabled=false; }
}
async function importFBCV(){
  const btn=$("#fbcvBtn"); btn.disabled=true; btn.textContent="Importando…";
  try{
    const data=await (await fetch("fbcv-2026-27.json",{cache:"no-cache"})).json();
    const b=F.writeBatch(db); let nr=0, nj=0, np=0, nd=0;
    const key=n=>String(n||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().replace(/[.\s]+/g," ").trim();
    for(const [fid,r] of Object.entries(data.rivales)){
      const id="fbcv-"+fid, ex=S.rivales.find(x=>x.id===id);
      const jug=r.jugadores.map(j=>typeof j==="string"?{nombre:j,dorsal:null}:j);
      const ya=new Map(Object.entries(ex?.plantilla||{}).map(([pid,j])=>[key(j.nombre),{pid,...j}]));
      const nuevos=jug.filter(j=>!ya.has(key(j.nombre)));
      if(!ex){ b.set(F.doc(col("rivales"),id),{nombre:r.nombre, entrenador:r.entrenador||"", fbcv:fid, creado:Date.now(),
          plantilla:Object.fromEntries(nuevos.map(j=>[uid6(),{nombre:j.nombre, dorsal:j.dorsal??null, pos:""}]))}); nr++; nj+=nuevos.length; continue; }
      const args=[];
      nuevos.forEach(j=>{ args.push(new F.FieldPath("plantilla",uid6()), {nombre:j.nombre, dorsal:j.dorsal??null, pos:""}); nj++; });
      // Dorsales: solo se rellenan los que estén vacíos, para no pisar los que hayáis puesto a mano
      jug.forEach(j=>{ const e=ya.get(key(j.nombre)); if(e && j.dorsal!=null && (e.dorsal===null||e.dorsal===undefined||e.dorsal==="")){ args.push(new F.FieldPath("plantilla",e.pid,"dorsal"), j.dorsal); nd++; } });
      if(args.length) b.update(F.doc(col("rivales"),id), ...args);
    }
    for(const p of data.partidos){
      if(p.fecha<today()) continue;
      const id="fbcv-"+p.fecha+"-"+p.rival;
      if(S.eventos.some(ev=>ev.id===id || (ev.tipo==="partido" && ev.fecha===p.fecha))) continue;
      const nombre=data.rivales[p.rival].nombre;
      b.set(F.doc(col("eventos"),id),{tipo:"partido", fecha:p.fecha, hora:p.hora, nota:(p.casa?"en casa contra ":"fuera contra ")+nombre, lugar:p.lugar, rival:"fbcv-"+p.rival,
        asistencia:{}, confirma:{}, notas:{}, notificada:true, creado:Date.now(), autor:S.user?.uid||""}); np++;
    }
    // Nuestros dorsales (solo los vacíos)
    Object.entries(data.propios||{}).forEach(([n,dor])=>{ const p=S.jug.find(x=>key(x.nombre)===key(n)); if(p && !hasDor(p)){ b.update(dref("jugadores",p.id),{dorsal:dor}); nd++; } });
    if(!nr && !nj && !np && !nd){ toast("Ya estaba todo importado"); return; }
    await run(()=>b.commit(), [np&&`${np} partidos`, nr&&`${nr} rivales`, nj&&`${nj} jugadores`, nd&&`${nd} dorsales`].filter(Boolean).join(", ")+" importados");
  }catch(e){ console.error(e); toast("No se pudo importar: "+errMsg(e)); }
  finally{ btn.disabled=false; btn.textContent="📥 Importar calendario y plantillas de la FBCV"; }
}
$("#rivNew").addEventListener("submit",e=>{
  e.preventDefault(); const nombre=$("#rivNombre").value.trim(); if(!nombre){ toast("Escribe el nombre del rival"); return; }
  const ref=F.doc(col("rivales"));
  run(()=>F.setDoc(ref,{nombre, plantilla:{}, creado:Date.now()}),"Rival añadido").then(ok=>{ if(ok){ $("#rivNombre").value=""; openRival(ref.id); } });
});


/* ---------- recordatorio de renovar la FBCV (solo el propietario de la app) ---------- */
async function fbcvFecha(){ try{ const d=await cargarFBCV(); const t=await F.getDoc(F.doc(db,"equipos",LEGACY_TEAM)); const m=[d?.copiado||"", t.data()?.fbcvRenovado||""].sort().pop();
  $("#fbcvFecha").textContent = m ? "Última: "+new Date(m+"T12:00").toLocaleDateString(LOC,{day:"numeric",month:"short"}) : ""; }catch{} }
/* ---------- sugerencias de mejora ---------- */
let sugUnsub=null, appOwner=null;
async function initSugerencias(){
  if(!S.user || !email()) { $("#sugAdmin").hidden=true; return; }
  try{ if(appOwner===null){ const t=await F.getDoc(F.doc(db,"equipos",LEGACY_TEAM)); appOwner=String(t.data()?.propietario||"").toLowerCase(); } }catch{ appOwner=""; }
  const soy = appOwner && appOwner===email();
  $("#sugAdmin").hidden=!soy; $("#fbcvCard").hidden=!soy;
  if(soy) fbcvFecha();
  if(soy && !sugUnsub){
    sugUnsub=F.onSnapshot(F.collection(db,"sugerencias"), s=>{
      const list=s.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(a.hecha?1:0)-(b.hecha?1:0)||(b.creado||0)-(a.creado||0));
      const np=list.filter(x=>!x.hecha).length; $("#sugCount").textContent = np+(np===1?" pendiente":" pendientes");
      $("#sugList").innerHTML = list.length ? list.map(x=>`<div class="sug ${x.hecha?"hecha":""}"><p>${esc(x.texto)}</p>
        <span class="mini">${esc(x.nombre||"Alguien")}${x.rol?" ("+esc(x.rol)+")":""} · ${esc(x.equipoNombre||x.equipo||"")} · ${esc(haceCuanto(x.creado||0))}</span>
        <span class="row"><button type="button" class="btn small ${x.hecha?"ghost":"ok"}" data-sughecha="${esc(x.id)}">${x.hecha?"Marcar pendiente":"✓ Hecha"}</button><button type="button" class="btn small danger" data-sugdel="${esc(x.id)}">Borrar</button></span></div>`).join("")
        : '<p class="note">Todavía no hay sugerencias.</p>';
    }, e=>console.warn(e));
  }
}
$("#sugSend").addEventListener("click",()=>{
  const texto=$("#sugText").value.trim(); if(!texto){ toast("Escribe tu sugerencia"); return; }
  const me=myPlayer(); if(!me){ toast("Para sugerir, vincúlate a tu nombre con «Soy yo»"); return; }
  run(()=>F.addDoc(F.collection(db,"sugerencias"),{texto:texto.slice(0,500), nombre:me.nombre, rol:me.rol==="entrenador"?"entrenador":"jugador", autor:email(), equipo:TEAM||"", equipoNombre:S.aj.nombre||"", creado:Date.now(), enviada:false, hecha:false}),"¡Gracias! Sugerencia enviada")
    .then(ok=>{ if(ok) $("#sugText").value=""; });
});

/* ---------- fantasy ---------- */
const fanCfg = () => { const f=S.aj.fantasy||{}; return {activo:!!f.activo, presupuesto:+f.presupuesto||50}; };
const isOwnerTeam = () => !!email() && String(S.aj.propietario||"").toLowerCase()===email();
const fanJugadores = () => activePlayers().filter(p=>p.rol!=="entrenador");
const puedeFan = () => { const me=myPlayer(); return !!me && me.rol!=="entrenador" && me.activo!==false; };
const precio = pid => { const v=(S.fan?.precios||{})[pid]; return v==null?10:+v; };
const evInicio = ev => new Date(ev.fecha+"T"+(ev.hora||"12:00")).getTime();
const fmtM = n => (Math.round(n*10)/10).toLocaleString("es-ES",{maximumFractionDigits:1})+" M";
let fanUnsubs=[], fanJornadaId=null;
function fanSync(){
  const on=teamOpen && fanCfg().activo;
  if(!on){ fanUnsubs.forEach(u=>u()); fanUnsubs=[]; fanJornadaId=null; S.fan=null; renderFantasy(); return; }
  if(!fanUnsubs.length){
    S.fan=S.fan||{precios:{}, clasificacion:{}};
    fanUnsubs.push(F.onSnapshot(F.doc(db,"equipos",TEAM,"fantasy","estado"),s=>{ S.fan={...(S.fan||{}),...(s.data()||{})}; renderFantasy(); },e=>console.warn(e)));
  }
  // jornada que toca: el próximo partido, o el último si aún estamos en el plazo de notas (48 h)
  const ahora=Date.now();
  const ps=S.eventos.filter(ev=>ev.tipo==="partido" && ev.hora).sort((a,b)=>evInicio(a)-evInicio(b));
  const jr = ps.filter(ev=>evInicio(ev)+50*3600e3>ahora)[0] || null;
  const id=jr?.id||null;
  if(id!==fanJornadaId){
    fanJornadaId=id; fanUnsubs.splice(1).forEach(u=>u()); S.fanMine={alin:null,votos:null,jornada:null};
    if(id && email()){
      fanUnsubs.push(F.onSnapshot(F.doc(db,"equipos",TEAM,"jornadas",id,"alineaciones",email()),s=>{ S.fanMine.alin=s.data()||null; if(!S.fanSel) S.fanSel=null; renderFantasy(); },e=>console.warn(e)));
      fanUnsubs.push(F.onSnapshot(F.doc(db,"equipos",TEAM,"jornadas",id,"votos",email()),s=>{ S.fanMine.votos=s.data()||null; renderFantasy(); },e=>console.warn(e)));
    }
    if(id) fanUnsubs.push(F.onSnapshot(F.doc(db,"equipos",TEAM,"jornadas",id),s=>{ S.fanMine.jornada=s.data()||null; renderFantasy(); },e=>console.warn(e)));
    S.fanSel=null; S.fanVotos=null;
  }
  renderFantasy();
}
// Importar una liga que ya se estaba jugando (valores y puntos), desde docs/fantasy-importado.json
async function importFantasy(){
  try{
    const data=await (await fetch("fantasy-importado.json",{cache:"no-cache"})).json();
    const key=n=>String(n||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().replace(/[.\s]+/g," ").trim();
    const buscar=n=>S.jug.find(p=>key(p.nombre)===key(n)) || S.jug.find(p=>key(p.nombre).startsWith(key(n)+" ")||key(n).startsWith(key(p.nombre)+" "));
    const precios={}, clas={}, falta=[];
    Object.entries(data.precios||{}).forEach(([n,v])=>{ const p=buscar(n); p?precios[p.id]=+v:falta.push(n); });
    Object.entries(data.clasificacion||{}).forEach(([n,x])=>{ const p=buscar(n); p?clas[p.id]={nombre:p.nombre,total:+x.total||0,jornadas:+x.jornadas||0,ultima:x.ultima??null}:falta.push(n); });
    if(!Object.keys(precios).length && !Object.keys(clas).length){ toast("No hay datos para importar todavía"); return; }
    const extra = data.ultima ? {ultima:data.ultima} : {};
    extra.precioHist = Object.fromEntries(Object.entries(precios).map(([pid,v])=>[pid,[{f:"importado",p:v}]]));
    await run(()=>F.setDoc(F.doc(db,"equipos",TEAM,"fantasy","estado"),{precios,clasificacion:clas,...extra,importado:Date.now()},{merge:true}),
      `Liga importada: ${Object.keys(precios).length} valores y ${Object.keys(clas).length} en la clasificación`+(falta.length?`. Sin encontrar: ${[...new Set(falta)].join(", ")}`:""));
  }catch(e){ console.error(e); toast("No se pudo importar: "+errMsg(e)); }
}
function renderFanCfg(){
  const f=fanCfg();
  $("#fanCfgTxt").textContent = f.activo ? `Activado · presupuesto de ${f.presupuesto} M por quinteto.` : "Desactivado. Si lo activas, cada partido será una jornada del fantasy.";
  $("#fanCfgEdit").hidden=!isOwnerTeam();
  if(isOwnerTeam() && !$("#fanCfg").contains(document.activeElement)){ $("#fanActivo").checked=f.activo; $("#fanPres").value=f.presupuesto; }
}
function renderFantasy(){
  const card=$("#fanCard"); if(!card) return;
  const f=fanCfg();
  card.hidden=!(teamOpen && f.activo);
  if(!f.activo){ $("#fanBody").innerHTML='<div class="empty"><b>Fantasy desactivado</b>El propietario del equipo lo puede activar en Ajustes.</div>'; return; }
  const jr=S.eventos.find(ev=>ev.id===fanJornadaId);
  const ahora=Date.now(); const ini=jr?evInicio(jr):0;
  const fase = !jr ? "nada" : ahora<ini ? "alineacion" : ahora<ini+2*3600e3 ? "jugando" : ahora<ini+48*3600e3 ? "notas" : "cierre";
  const rival = jr ? (S.rivales.find(r=>r.id===jr.rival)?.nombre || (jr.nota||"").replace(/^(en casa|fuera) contra /,"")) : "";
  const cuando = jr ? new Date(ini).toLocaleString("es-ES",{weekday:"long",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}) : "";
  const tengo=!!S.fanMine?.alin;
  card.innerHTML=`<span class="g-ic or">🏀</span><span><b>Fantasy</b><br><span class="note">${!jr?"Sin jornada a la vista":fase==="alineacion"?(tengo?"✅ Quinteto hecho · ":"⚠️ Haz tu quinteto · ")+"cierra "+esc(cuando):fase==="notas"?(S.fanMine?.votos?"✅ Notas puestas":"⭐ Pon nota a tus compañeros"):"Jornada en juego"}</span></span><span class="g-ch" aria-hidden="true">›</span>`;
  if(!$("#v-fantasy") || $("#v-fantasy").hidden && !$("#fanBody").innerHTML.trim()) {}
  const box=$("#fanBody"); if(box.contains(document.activeElement) && document.activeElement.tagName==="INPUT") return;
  let h="";
  if(jr) h+=`<div class="card"><h3>Jornada · ${esc(rival)}</h3><span class="note">${esc(cuando)}${jr.lugar?" · 📍 "+esc(jr.lugar):""}</span>`;
  if(!jr) h+=`<div class="card"><p class="note">No hay ningún partido con hora en el calendario. Cuando lo haya, aquí harás tu quinteto.</p>`;
  else if(!puedeFan()) h+= myPlayer()?.rol==="entrenador" ? `<p class="note">👨‍🏫 El entrenador no juega al fantasy, pero sí puede poner notas después del partido.</p>` : `<p class="note">Para jugar, vincula tu cuenta con tu nombre en Resumen («Soy yo»).</p>`;
  else if(fase==="alineacion") h+=pizarra(f);
  else{
    const a=S.fanMine?.alin;
    h+= a ? `<p class="note">Tu quinteto (solo lo ves tú):</p><div class="chips">${a.jugadores.map(pid=>`<span class="chip" aria-pressed="true">${a.capitan===pid?"© ":""}${esc(playerById(pid)?.nombre||"?")}</span>`).join("")}</div>`
          : `<p class="note">No hiciste quinteto para esta jornada.</p>`;
  }
  if(jr && fase==="notas" && email()) h+=votacion(jr);
  if(jr && fase==="jugando") h+=`<p class="note">⏱️ Partido en juego. Las notas se abren 2 horas después del inicio.</p>`;
  h+="</div>";
  h+=clasificacion();
  box.innerHTML=h;
}
function pizarra(f){
  const sel = S.fanSel || (S.fanMine?.alin ? {jugadores:[...S.fanMine.alin.jugadores], capitan:S.fanMine.alin.capitan} : {jugadores:[],capitan:null});
  S.fanSel=sel;
  const gasto=sel.jugadores.reduce((a,pid)=>a+precio(pid),0), queda=f.presupuesto-gasto;
  let h=`<div class="budget"><span>Presupuesto: <b class="${queda<0?"over":""}">${fmtM(queda)}</b> libres</span><span class="mini">${sel.jugadores.length}/5 · ${fmtM(gasto)} de ${f.presupuesto} M</span></div>
    <div class="pizarra">${fanJugadores().map(p=>{ const on=sel.jugadores.includes(p.id); const full=!on && (sel.jugadores.length>=5 || precio(p.id)>queda);
      return `<button type="button" class="fj" data-fanpick="${esc(p.id)}" aria-pressed="${on}" ${full?"disabled":""}><span class="av ${hasDor(p)?"num":""}">${esc(avTxt(p))}</span><b>${esc(shortName(p.nombre))}</b><span class="pr">${fmtM(precio(p.id))}</span></button>`; }).join("")}</div>`;
  if(sel.jugadores.length) h+=`<p class="mini" style="margin:6px 0 2px">Capitán (puntúa doble):</p><div class="row">${sel.jugadores.map(pid=>`<button type="button" class="cap" data-fancap="${esc(pid)}" aria-pressed="${sel.capitan===pid}">© ${esc(shortName(playerById(pid)?.nombre))}</button>`).join("")}</div>`;
  const ok=sel.jugadores.length===5 && sel.capitan && queda>=0;
  h+=`<button type="button" class="btn big" id="fanSaveAlin" ${ok?"":"disabled"}>${S.fanMine?.alin?"Guardar cambios":"Guardar quinteto"}</button>
     <span class="note">${ok?"Puedes cambiarlo hasta que empiece el partido.":"Elige 5 jugadores y un capitán sin pasarte del presupuesto."}</span>`;
  return h;
}
function votacion(jr){
  const me=myPlayer();
  const jugaron=fanJugadores().filter(p=>{ const a=(jr.asistencia||{})[p.id]; const c=p.email?(jr.confirma||{})[pkey(p)]:null; return a ? (a==="si"||a==="tarde") : c==="si"; }).filter(p=>!me||p.id!==me.id);
  if(!jugaron.length) return `<p class="note">Cuando se pase lista (o hayan dicho «Voy»), aquí podrás poner nota a los que jugaron.</p>`;
  const v = S.fanVotos || (S.fanMine?.votos ? {notas:{...(S.fanMine.votos.notas||{})}, mvp:S.fanMine.votos.mvp||null} : {notas:{},mvp:null});
  S.fanVotos=v;
  const ESC=[-2,-1,0,1,2,3,4,5,6,7,8,9,10];
  const coach = me?.rol==="entrenador";
  let h=`<h3 style="margin-top:14px">⭐ ${coach?"MVP del partido":"Notas del partido"}</h3><p class="note">${coach?"Como entrenador solo votas al MVP; tus notas no cuentan en la media.":"De −2 a 10. Son anónimas: nadie sabe qué nota ha puesto cada uno."}</p>`;
  h+=jugaron.map(p=>`<div class="stack" style="border-top:1px dashed var(--line);padding-top:8px;margin-top:6px"><div class="who-line"><b>${esc(p.nombre)}</b><button type="button" class="cap" data-fanmvp="${esc(p.id)}" aria-pressed="${v.mvp===p.id}">🏆 MVP</button></div>
     ${coach?"":`<div class="nota-sel">${ESC.map(n=>`<button type="button" data-fannota="${esc(p.id)}|${n}" aria-pressed="${v.notas[p.id]===n}">${n}</button>`).join("")}</div>`}</div>`).join("");
  const ok=(coach || jugaron.every(p=>v.notas[p.id]!==undefined)) && v.mvp;
  h+=`<button type="button" class="btn big" id="fanSaveVotos" ${ok?"":"disabled"} style="margin-top:10px">${S.fanMine?.votos?"Guardar cambios":"Enviar notas"}</button>
     <span class="note">${ok?"Puedes cambiarlas hasta 2 días después del partido.":"Pon nota a todos y elige un MVP."}</span>`;
  return h;
}
function clasificacion(){
  const c=Object.entries(S.fan?.clasificacion||{}).map(([em,x])=>({em,...x})).sort((a,b)=>(b.total||0)-(a.total||0));
  const ult=S.fan?.ultima;
  let h=`<div class="card"><h3>🏆 Clasificación</h3>`;
  const yo=myPlayer()?.id;
  if(!c.length) h+=`<p class="note">Aún no se ha jugado ninguna jornada.</p>`;
  else h+=`<ol class="clas">${c.map((x,i)=>`<li class="${x.em===yo?"yo":""}"><span class="pos">${i+1}</span><span>${esc(x.nombre||x.em)}${x.em===yo?' <span class="pill newp">tú</span>':""}<br><span class="mini">${x.jornadas||0} jornadas${x.ultima!=null?" · última: "+x.ultima+" pts":""}</span></span><span class="pts">${Math.round((x.total||0)*10)/10}</span></li>`).join("")}</ol>`;
  if(ult) h+=`<p class="note" style="margin-top:8px">Última jornada (${esc(ult.rival||"")}): MVP <b>${esc(ult.mvpNombre||"–")}</b>${ult.ganador?` · ganó <b>${esc(ult.ganador)}</b> con ${ult.ganadorPts} pts`:""}.</p>`;
  if(c.length) h+=`<div class="row" style="margin-top:8px"><button type="button" class="btn small ghost" id="fanTarjeta">📤 Compartir clasificación</button><button type="button" class="btn small ghost" id="fanMercado">${S.verMercado?"Ocultar mercado":"📈 Ver mercado"}</button></div>`;
  return h+"</div>"+(S.verMercado?mercado():"")+historialFantasy();
}
function handleFanClick(t,d){
  if(d.fanpick){ const s=S.fanSel; const i=s.jugadores.indexOf(d.fanpick); if(i>=0){ s.jugadores.splice(i,1); if(s.capitan===d.fanpick) s.capitan=null; } else if(s.jugadores.length<5) s.jugadores.push(d.fanpick); renderFantasy(); return true; }
  if(d.fancap){ S.fanSel.capitan=d.fancap; renderFantasy(); return true; }
  if(t.id==="fanSaveAlin"){ const s=S.fanSel; const jr=S.eventos.find(ev=>ev.id===fanJornadaId); if(!jr||Date.now()>=evInicio(jr)){ toast("La jornada ya ha empezado"); return true; }
    const total=s.jugadores.reduce((a,pid)=>a+precio(pid),0);
    run(()=>F.setDoc(F.doc(db,"equipos",TEAM,"jornadas",fanJornadaId,"alineaciones",email()),{jugadores:s.jugadores, capitan:s.capitan, coste:total, nombre:myName(), actualizado:F.serverTimestamp()}),"Quinteto guardado ✅"); return true; }
  if(d.fannota){ const [pid,n]=d.fannota.split("|"); S.fanVotos.notas[pid]=+n; renderFantasy(); return true; }
  if(d.fanmvp){ S.fanVotos.mvp=d.fanmvp; renderFantasy(); return true; }
  if(t.id==="fanSaveVotos"){ const v=S.fanVotos; run(()=>F.setDoc(F.doc(db,"equipos",TEAM,"jornadas",fanJornadaId,"votos",email()),{notas:v.notas, mvp:v.mvp, actualizado:F.serverTimestamp()}),"Notas enviadas ⭐"); return true; }
  if(t.id==="fanImport"){ importFantasy(); return true; }
  if(t.id==="fanSave"){ const pres=Math.round(+$("#fanPres").value)||50; if(pres<20||pres>200){ toast("Pon un presupuesto entre 20 y 200"); return true; }
    run(()=>F.updateDoc(teamRef(),{fantasy:{activo:$("#fanActivo").checked, presupuesto:pres}}),"Fantasy guardado"); return true; }
  if(d.sughecha){ const hecha=t.textContent.includes("✓"); run(()=>F.updateDoc(F.doc(db,"sugerencias",d.sughecha),{hecha}), hecha?"Marcada como hecha":"Marcada como pendiente"); return true; }
  if(d.sugdel){ armed(t,"¿Borrar?",()=>run(()=>F.deleteDoc(F.doc(db,"sugerencias",d.sugdel)),"Borrada")); return true; }
  return false;
}


/* ---------- tanda 1 de mejoras ---------- */
function descargar(nombre, contenido, tipo){
  try{ const blob=new Blob([contenido],{type:tipo}); const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=nombre; document.body.append(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },1500); }
  catch(e){ console.error(e); toast("No se pudo descargar el archivo."); }
}
// Registro de cambios: se escribe en el mismo lote que el cambio
function logCambio(b, accion, detalle){ b.set(F.doc(col("registro")),{accion, detalle:String(detalle).slice(0,160), autor:myName(), creado:Date.now()}); }
const multaTxt = m => `${m.jugadorNombre||playerById(m.jugador)?.nombre||"?"} · ${m.tipoNombre}${qtyTxt(m)} · ${eur(m.importe)}`;

// Letra grande (preferencia de cada móvil)
function aplicarLetra(){ const on=!!store.get("multas.letraGrande",false); document.documentElement.classList.toggle("grande",on); const c=$("#letraGrande"); if(c) c.checked=on; }
document.addEventListener("change",e=>{ if(e.target.id==="fotoIn" && e.target.files?.[0]) subirFoto(e.target.files[0]); });
$("#letraGrande").addEventListener("change",e=>{ store.set("multas.letraGrande",e.target.checked); aplicarLetra(); });
aplicarLetra();

// El bote: gráfica por mes, faltas más repetidas y gastos
const MES_CORTO=["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
function renderBote(){
  const card=$("#boteCard"); if(!card) return;
  const list=S.multas.filter(inPeriod);
  card.hidden = !S.ready.m || (!list.length && !(S.gastos||[]).length);
  const cobrado=list.filter(m=>m.pagada).reduce((a,m)=>a+(+m.importe||0),0);
  const gastado=(S.gastos||[]).reduce((a,g)=>a+(+g.importe||0),0);
  $("#boteQueda").textContent=`Cobrado ${eur(cobrado)} · gastado ${eur(gastado)} · queda ${eur(cobrado-gastado)}`;
  // últimos 6 meses
  const hoy=new Date(); const meses=[];
  for(let i=5;i>=0;i--){ const d=new Date(hoy.getFullYear(),hoy.getMonth()-i,1); meses.push({k:d.getFullYear()+"-"+pad(d.getMonth()+1), l:MES_CORTO[d.getMonth()], v:0}); }
  list.forEach(m=>{ const k=(m.fecha||"").slice(0,7); const x=meses.find(y=>y.k===k); if(x) x.v+=+m.importe||0; });
  const W=320,H=150,pt=20,pb=22,gap=10,bw=(W-gap*7)/6, max=Math.max(1,...meses.map(x=>x.v));
  const y=v=>H-pb-(v/max)*(H-pt-pb);
  const barPath=(x,v)=>{ const top=y(v), b=H-pb, r=Math.min(4,(b-top)); if(v<=0) return ""; return `M${x},${b}V${top+r}Q${x},${top} ${x+r},${top}H${x+bw-r}Q${x+bw},${top} ${x+bw},${top+r}V${b}Z`; };
  let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Multas por mes, últimos 6 meses">`;
  svg+=`<line class="base" x1="0" x2="${W}" y1="${H-pb}" y2="${H-pb}"/>`;
  meses.forEach((x,i)=>{ const bx=gap+i*(bw+gap); const now=i===5;
    svg+=`<g><title>${x.l}: ${eur(x.v)}</title><rect class="hit" x="${bx-gap/2}" y="0" width="${bw+gap}" height="${H}"/><path class="bar ${now?"now":""}" d="${barPath(bx,x.v)}"/>`+
      `<text class="ax" x="${bx+bw/2}" y="${H-6}" text-anchor="middle">${x.l}</text>`+
      (now&&x.v>0?`<text class="val" x="${bx+bw/2}" y="${y(x.v)-5}" text-anchor="middle">${eur(x.v)}</text>`:"")+`</g>`; });
  $("#boteChart").innerHTML=svg+"</svg>";
  const por={}; list.forEach(m=>{ por[m.tipoNombre]=(por[m.tipoNombre]||0)+(m.unidad==="minuto"?1:(m.cantidad||1)); });
  const top=Object.entries(por).sort((a,b)=>b[1]-a[1]).slice(0,3);
  $("#boteTop").textContent = top.length ? "Lo que más se repite: "+top.map(([n,c])=>`${n} (${c})`).join(" · ") : "";
  const gs=[...(S.gastos||[])].sort((a,b)=>(b.fecha||"").localeCompare(a.fecha||""));
  $("#gastosN").textContent=gs.length?`(${gs.length})`:"";
  $("#gastosList").innerHTML = gs.length ? gs.map(g=>`<li class="gasto"><span>${esc(g.concepto)} <span class="mini">· ${esc(dayName(g.fecha))}</span></span><span><b>${eur(g.importe)}</b>${S.canWrite?` <button type="button" class="btn small danger" data-gdel="${esc(g.id)}">✕</button>`:""}</span></li>`).join("") : '<li class="note">Todavía no se ha gastado nada del bote.</li>';
  $("#gastoForm").hidden=!S.canWrite;
}
$("#gastoForm").addEventListener("submit",e=>{
  e.preventDefault(); const concepto=$("#gConcepto").value.trim(), importe=+$("#gImporte").value;
  if(!concepto||!(importe>0)){ toast("Pon el concepto y el importe"); return; }
  const b=F.writeBatch(db); b.set(F.doc(col("gastos")),{concepto, importe, fecha:today(), autor:myName(), creado:Date.now()}); logCambio(b,"gasto",`${concepto} · ${eur(importe)}`);
  run(()=>b.commit(),"Gasto apuntado").then(ok=>{ if(ok){ $("#gConcepto").value=""; $("#gImporte").value=""; } });
});

// Pagos del mes (para quien cobra)
function renderPagos(){
  const card=$("#pagosCard"); if(!card) return;
  card.hidden=!S.canWrite;
  if(!S.canWrite) return;
  const ym=today().slice(0,7);
  const rows=activePlayers().map(p=>{ const pend=S.multas.filter(m=>m.jugador===p.id&&!m.pagada); const ahora=pend.filter(m=>mesCobro(m.fecha)<=ym);
    return {p, total:pend.reduce((a,m)=>a+(+m.importe||0),0), ahora:ahora.reduce((a,m)=>a+(+m.importe||0),0)}; }).sort((a,b)=>b.total-a.total||sortPlayers(a.p,b.p));
  const deben=rows.filter(r=>r.total>0);
  $("#pagosRes").textContent = deben.length ? `${deben.length} deben · ${eur(deben.reduce((a,r)=>a+r.total,0))}` : "Todos al día ✅";
  $("#pagosList").innerHTML = rows.map(r=>`<div class="pg"><span class="av ${hasDor(r.p)?"num":""}">${esc(avTxt(r.p))}</span><span><b>${esc(r.p.nombre)}</b><br><span class="mini">${r.total>0?`Debe ${eur(r.total)}${r.ahora<r.total?` (${eur(r.ahora)} de este mes)`:""}`:"Al día ✅"}</span></span>
    <span class="acc">${r.total>0?`<button type="button" class="btn small ghost" data-recpago="${esc(r.p.id)}|${r.total}" ${r.p.email?"":"disabled title=\"No tiene cuenta\""}>🔔 Recordar</button><button type="button" class="btn small ok" data-payall="${esc(r.p.id)}">Cobrar</button>`:""}</span></div>`).join("");
}
// Registro de cambios
function renderLog(){
  if($("#logBox").hidden) return;
  const l=[...(S.registro||[])].sort((a,b)=>(b.creado||0)-(a.creado||0)).slice(0,60);
  const IC={multa:"💸",cobro:"✅",descobro:"↩️",quitar:"🗑️",gasto:"🧾"};
  $("#logList").innerHTML = l.length ? l.map(x=>`<li class="logi">${IC[x.accion]||"•"} ${esc(x.detalle)}<br><span class="mini">${esc(shortName(x.autor))} · ${esc(haceCuanto(x.creado||0))}</span></li>`).join("") : '<li class="note">Todavía no hay cambios registrados.</li>';
}
// Excel (CSV con punto y coma, que es lo que abre Excel en español)
function exportarCSV(){
  const q=v=>`"${String(v??"").replace(/"/g,'""')}"`;
  const filas=[["Fecha","Jugador","Falta","Cantidad","Importe (€)","Estado","Nota"]];
  [...S.multas].sort((a,b)=>(a.fecha||"").localeCompare(b.fecha||"")).forEach(m=>filas.push([m.fecha, playerById(m.jugador)?.nombre||m.jugadorNombre, m.tipoNombre, m.cantidad||1, String(+m.importe||0).replace(".",","), m.pagada?"Cobrada":"Pendiente", m.nota||""]));
  descargar(`multas-${(S.aj.nombre||"equipo").replace(/\W+/g,"-")}-${today()}.csv`, "﻿"+filas.map(f=>f.map(q).join(";")).join("\r\n"), "text/csv;charset=utf-8");
}
// Calendario del móvil (.ics)
function icsDe(evs){
  const f=s=>s.replace(/[-:]/g,""); const lin=[ "BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Multas del equipo//ES","CALSCALE:GREGORIAN" ];
  const escI=s=>String(s||"").replace(/[\\,;]/g,m=>"\\"+m).replace(/\n/g,"\\n");
  evs.forEach(ev=>{ const h=ev.hora||"12:00"; const ini=new Date(ev.fecha+"T"+h); const fin=new Date(ini.getTime()+(ev.tipo==="partido"?2:1.5)*3600e3);
    const loc=d=>d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate())+"T"+pad(d.getHours())+pad(d.getMinutes())+"00";
    lin.push("BEGIN:VEVENT","UID:"+ev.id+"@multas-"+TEAM,"DTSTAMP:"+f(new Date().toISOString().slice(0,19))+"Z","DTSTART:"+loc(ini),"DTEND:"+loc(fin),
      "SUMMARY:"+escI(`${ev.tipo==="partido"?"🏀 Partido":"Entreno"}${ev.nota?" · "+ev.nota:""} (${S.aj.nombre||""})`), ...(ev.lugar?["LOCATION:"+escI(ev.lugar)]:[]), "END:VEVENT"); });
  lin.push("END:VCALENDAR"); return lin.join("\r\n");
}
const mapaUrl = lugar => "https://www.google.com/maps/search/?api=1&query="+encodeURIComponent(lugar+", Comunitat Valenciana");
// Ranking de asistencia del mes
function renderRankMes(){
  const card=$("#asRankCard"); if(!card) return;
  const ym=today().slice(0,7);
  const evs=S.eventos.filter(e=>(e.fecha||"").startsWith(ym) && e.asistencia && Object.keys(e.asistencia).length);
  card.hidden=!evs.length; if(!evs.length) return;
  const r=activePlayers().filter(p=>p.rol!=="entrenador").map(p=>{ let v=0,t=0; evs.forEach(e=>{ const a=e.asistencia[p.id]; if(a){ t++; if(attended(a)) v++; } }); return {p,v,t}; }).filter(x=>x.t).sort((a,b)=>b.v/b.t-a.v/a.t||b.v-a.v);
  const top=r.slice(0,3), cola=r.filter(x=>x.v/x.t<0.5).slice(-2);
  $("#asRank").innerHTML = `<p class="note">${["🥇","🥈","🥉"].map((m,i)=>top[i]?`${m} <b>${esc(shortName(top[i].p.nombre))}</b> ${top[i].v}/${top[i].t}`:"").filter(Boolean).join(" · ")}</p>`+
    (cola.length?`<p class="mini">A mejorar: ${cola.map(x=>`${esc(shortName(x.p.nombre))} ${x.v}/${x.t}`).join(" · ")}</p>`:"");
}
// Cumpleaños
function renderCumple(){
  const me=myPlayer(); const c=$("#cumpleCard"); if(!c) return;
  c.hidden=!me; if(!me) return;
  if(document.activeElement!==$("#cumpleIn")) $("#cumpleIn").value=me.cumple||"";
}
$("#cumpleSave").addEventListener("click",()=>{ const me=myPlayer(); if(!me) return; const v=$("#cumpleIn").value||"";
  run(()=>F.updateDoc(dref("jugadores",me.id),{cumple:v}), v?"Cumpleaños guardado 🎂":"Cumpleaños quitado"); });
const cumpleHoy = () => { const md=today().slice(5); return activePlayers().filter(p=>(p.cumple||"").slice(5)===md); };
// Copia de seguridad (solo el propietario del equipo)
async function copiaSeguridad(){
  const btn=$("#backupBtn"); btn.disabled=true;
  try{
    const rivales=[];
    for(const r of S.rivales){ let notas=[]; try{ notas=(await F.getDocs(F.collection(db,"equipos",TEAM,"rivales",r.id,"notas"))).docs.map(d=>({id:d.id,...d.data()})); }catch{} rivales.push({...r, notas}); }
    const data={exportado:new Date().toISOString(), equipo:{id:TEAM,...S.aj}, jugadores:S.jug, tipos:S.tipos, multas:S.multas, gastos:S.gastos||[], eventos:S.eventos, avisos:S.avisos, planes:S.planes, rivales, fantasy:S.fan||null};
    descargar(`copia-${TEAM}-${today()}.json`, JSON.stringify(data,null,1), "application/json");
  } finally { btn.disabled=false; }
}
// Convocatoria
function convHtml(ev){
  if(ev.tipo!=="partido") return "";
  const conv=ev.convocados||[]; const me=myPlayer();
  let h="";
  if(conv.length) h+=`<span class="note">📋 Convocados: ${conv.length}${me&&conv.includes(me.id)?' · <b style="color:var(--ok)">estás convocado</b>':me&&me.rol!=="entrenador"?" · no estás en la lista":""}</span>`;
  if(S.canWrite && S.convEv===ev.id){
    const sel=S.convSel||new Set(conv); S.convSel=sel;
    h+=`<div class="conv">${activePlayers().filter(p=>p.rol!=="entrenador").map(p=>`<button type="button" data-convp="${esc(p.id)}" aria-pressed="${sel.has(p.id)}">${hasDor(p)?"#"+esc(p.dorsal)+" ":""}${esc(shortName(p.nombre))}</button>`).join("")}</div>
      <div class="row"><button type="button" class="btn small" data-convsave="${esc(ev.id)}">Guardar y avisar (${sel.size})</button><button type="button" class="btn small ghost" data-convcancel="1">Cancelar</button></div>`;
  }
  return h;
}
function handleTanda1(t,d){
  if(t.id==="csvBtn"){ exportarCSV(); return true; }
  if(t.id==="logBtn"){ $("#logBox").hidden=!$("#logBox").hidden; renderLog(); return true; }
  if(t.id==="icsAll"){ const evs=S.eventos.filter(e=>e.fecha>=today()); if(!evs.length){ toast("No hay entrenos ni partidos próximos"); return true; } descargar(`calendario-${TEAM}.ics`, icsDe(evs), "text/calendar"); toast("Ábrelo para añadirlos al calendario"); return true; }
  if(d.ics){ const ev=evById(d.ics); if(ev) descargar(`${ev.tipo}-${ev.fecha}.ics`, icsDe([ev]), "text/calendar"); return true; }
  if(d.gdel){ armed(t,"¿Borrar?",()=>run(()=>F.deleteDoc(F.doc(col("gastos"),d.gdel)),"Gasto borrado")); return true; }
  if(d.recpago){ const [pid,imp]=d.recpago.split("|"); const p=playerById(pid);
    run(()=>F.addDoc(col("recordatorios"),{jugador:pid, importe:+imp, creado:Date.now(), enviado:false, autor:myName()}),`Recordatorio enviado a ${shortName(p?.nombre)}. Le llegará en unos minutos`); return true; }
  if(t.id==="backupBtn"){ copiaSeguridad(); return true; }
  if(d.conv){ S.convEv = S.convEv===d.conv?null:d.conv; S.convSel=null; renderAsis(); return true; }
  if(d.convp){ S.convSel.has(d.convp)?S.convSel.delete(d.convp):S.convSel.add(d.convp); renderAsis(); return true; }
  if(d.convcancel){ S.convEv=null; S.convSel=null; renderAsis(); return true; }
  if(d.convsave){ const lista=[...S.convSel]; run(()=>F.updateDoc(dref("eventos",d.convsave),{convocados:lista, convocAviso:false}),`Convocatoria guardada (${lista.length}). Se avisará a los convocados`).then(ok=>{ if(ok){ S.convEv=null; S.convSel=null; renderAsis(); } }); return true; }
  return false;
}


/* ---------- tanda 2 ---------- */
const keyN = n => String(n||"").normalize("NFD").replace(/[̀-ͯ]/g,"").toUpperCase().replace(/[.\s]+/g," ").trim();
function mismaPersona(corto, largo){ const a=keyN(corto), b=keyN(largo); if(!a||!b) return false; if(a===b) return true; const at=a.split(" "), bt=b.split(" ");
  if(a.replace(/ /g,"")===b.replace(/ /g,"").slice(0,a.replace(/ /g,"").length) && a.length<=4) return true; // iniciales (S T ↔ S T M)
  return at.length>=2 && at.every((t,i)=>bt[i]===t); }
// Estadísticas y liga de la FBCV (archivo público junto a la app)
let FBCV=null;
async function cargarFBCV(){ if(FBCV) return FBCV; try{ FBCV=await (await fetch("fbcv-stats.json",{cache:"no-cache"})).json(); }catch{ FBCV={}; } renderLiga(); renderScouting(); return FBCV; }
const statsRival = (rid, nombre) => { const fid=String(rid||"").replace("fbcv-",""); return (FBCV?.rivales?.[fid]||[]).find(x=>mismaPersona(nombre,x.n)); };
const statsPropias = nombre => (FBCV?.propios||[]).find(x=>mismaPersona(nombre,x.n));
const statTxt = s => s ? `<span class="stat-mini">📊 <b>${s.pts}</b> pts/p · ${s.min} min · ${s.t3} triples · TL ${esc(s.tl)} · ${s.pj} PJ</span>` : "";
function renderLiga(){
  const box=$("#ligaBox"); if(!box||!FBCV?.clasificacion) return;
  const nos=FBCV.clasificacion.find(x=>/ONTINYENT/i.test(x.equipo));
  $("#ligaPos").textContent = nos ? `Vamos ${nos.pos}.º · ${nos.v}-${nos.p}` : "";
  box.innerHTML=`<div class="tblwrap"><table class="liga"><thead><tr><th>#</th><th>Equipo</th><th>J</th><th>G</th><th>P</th><th>+/-</th><th>Pts</th></tr></thead><tbody>${FBCV.clasificacion.map(x=>`<tr class="${/ONTINYENT/i.test(x.equipo)?"nos":""}"><td>${x.pos}</td><td>${esc(x.equipo)}</td><td>${x.j}</td><td>${x.v}</td><td>${x.p}</td><td>${x.pf-x.pc>0?"+":""}${x.pf-x.pc}</td><td>${x.pts}</td></tr>`).join("")}</tbody></table></div>
    <h4 style="margin:12px 0 4px">Nuestros resultados</h4>${(FBCV.resultados||[]).slice().reverse().map(r=>{ const w=r.nos>r.ellos; return `<div class="res"><span>${esc(dayName(r.fecha))} · ${r.casa?"🏠":"✈️"} ${esc(r.rival)}</span><b class="${w?"w":"l"}">${w?"G":"P"} ${r.nos}-${r.ellos}</b></div>`; }).join("")}
    <p class="mini">Datos de la FBCV copiados el ${esc(FBCV.copiado||"")}. Se actualizan cuando lo pidas.</p>`;
}
// Calendario mensual
let calMes=null, calDia=null;
function renderCal(){
  const box=$("#calBox"); if(!box||box.hidden) return;
  const hoy=new Date(); if(!calMes) calMes=new Date(hoy.getFullYear(),hoy.getMonth(),1);
  const y=calMes.getFullYear(), m=calMes.getMonth(); const primero=(new Date(y,m,1).getDay()+6)%7; const dias=new Date(y,m+1,0).getDate();
  const evs=S.eventos.filter(e=>(e.fecha||"").startsWith(y+"-"+pad(m+1)));
  let h=`<div class="who-line"><button type="button" class="btn small ghost" data-calnav="-1" aria-label="Mes anterior">‹</button><h3>${MESES[m]} ${y}</h3><button type="button" class="btn small ghost" data-calnav="1" aria-label="Mes siguiente">›</button></div><div class="cal">`;
  h+=["L","M","X","J","V","S","D"].map(d=>`<span class="dow">${d}</span>`).join("");
  for(let i=0;i<primero;i++) h+="<span></span>";
  for(let d=1;d<=dias;d++){ const f=y+"-"+pad(m+1)+"-"+pad(d); const de=evs.filter(e=>e.fecha===f);
    h+=`<button type="button" data-caldia="${f}" class="${f===today()?"hoy":""}" aria-pressed="${calDia===f}"><span>${d}</span><span class="dots">${de.map(e=>`<i class="${e.tipo==="partido"?"p":""}"></i>`).join("")}</span></button>`; }
  h+="</div>";
  if(calDia){ const de=S.eventos.filter(e=>e.fecha===calDia); h+= de.length ? `<ul class="list" style="margin-top:10px">${de.map(ev=>evCard(ev, evInicioMs(ev)+2*3600e3>Date.now())).join("")}</ul>` : `<p class="note" style="margin-top:8px">Nada el ${esc(dayName(calDia))}.</p>`; }
  box.innerHTML=h;
}
const evInicioMs = ev => new Date(ev.fecha+"T"+(ev.hora||"12:00")).getTime();
// Ficha de jugador
let fichaId=null;
function abrirFicha(pid){ fichaId=pid; location.hash="ficha"; renderFicha(); }
function renderFicha(){
  const box=$("#fichaBox"); if(!box) return;
  if(!fichaId){ box.innerHTML='<p class="note">Elige un jugador en la clasificación o en la plantilla para ver su ficha.</p>'; return; }
  const p=playerById(fichaId); if(!p){ box.innerHTML='<p class="note">No se encuentra el jugador.</p>'; return; }
  const ms=S.multas.filter(m=>m.jugador===p.id); const T=totals(ms.filter(inPeriod));
  let vino=0,tot=0; S.eventos.forEach(e=>{ const a=(e.asistencia||{})[p.id]; if(a){ tot++; if(attended(a)) vino++; } });
  const st=statsPropias(p.nombre); const fan=S.fan?.clasificacion?.[p.id]; const precioF=(S.fan?.precios||{})[p.id];
  const puedoFoto = S.canWrite || myPlayer()?.id===p.id;
  box.innerHTML=`<div class="card"><div class="ficha-h">${p.foto?`<img class="ficha-foto" src="${esc(p.foto)}" alt="">`:`<span class="ficha-foto">${esc(avTxt(p))}</span>`}
      <div><h2 style="margin:0">${esc(p.nombre)}</h2><span class="note">${p.rol==="entrenador"?"Entrenador/a":"Jugador/a"}${hasDor(p)?" · #"+esc(p.dorsal):""}${p.cumple?" · 🎂 "+esc(new Date(p.cumple+"T12:00").toLocaleDateString(LOC,{day:"numeric",month:"long"})):""}</span></div></div>
    ${puedoFoto?`<label class="f">Foto (opcional)<input type="file" id="fotoIn" accept="image/*"></label>`:""}</div>
  <div class="card"><h3>Esta temporada</h3><div class="kv">
    <div><small>Multas</small><b>${eur(T.t)}</b></div><div><small>Debe</small><b>${eur(T.p)}</b></div>
    <div><small>Asistencia</small><b>${tot?Math.round(vino/tot*100)+"%":"–"}</b><span class="mini"> ${vino}/${tot}</span></div>
    ${st?`<div><small>Puntos/partido</small><b>${st.pts}</b></div><div><small>Minutos</small><b>${st.min}</b></div><div><small>Triples</small><b>${st.t3}</b></div><div><small>Tiros libres</small><b>${esc(st.tl)}</b></div><div><small>Partidos</small><b>${st.pj}</b></div>`:""}
    ${fanCfg().activo&&p.rol!=="entrenador"?`<div><small>Fantasy</small><b>${precioF!=null?fmtM(precioF):"10 M"}</b></div>${fan?`<div><small>Pts fantasy</small><b>${fan.total}</b></div>`:""}`:""}
  </div>${st?`<p class="mini">Estadísticas de la FBCV (copiadas el ${esc(FBCV?.copiado||"")}).</p>`:""}</div>`;
}
async function subirFoto(file){
  try{
    const img=await createImageBitmap(file); const k=Math.min(1,200/Math.max(img.width,img.height));
    const c=document.createElement("canvas"); c.width=Math.round(img.width*k); c.height=Math.round(img.height*k); c.getContext("2d").drawImage(img,0,0,c.width,c.height);
    const url=c.toDataURL("image/jpeg",0.8);
    await run(()=>F.updateDoc(dref("jugadores",fichaId),{foto:url}),"Foto guardada");
  }catch(e){ console.error(e); toast("No se pudo leer esa imagen."); }
}
// Fantasy: historial por jornadas y mercado de precios
function historialFantasy(){
  const js=(S.fanJornadas||[]).filter(j=>j.cerrada).sort((a,b)=>(a.fecha||"").localeCompare(b.fecha||""));
  if(!js.length) return "";
  const porEmail=Object.fromEntries(S.jug.filter(p=>p.email).map(p=>[pkey(p),p]));
  const gente=[...new Set(js.flatMap(j=>Object.keys(j.resultados||{})))];
  const filas=gente.map(em=>({p:porEmail[em], em, v:js.map(j=>(j.resultados||{})[em])})).sort((a,b)=>b.v.reduce((s,x)=>s+(x||0),0)-a.v.reduce((s,x)=>s+(x||0),0));
  return `<div class="card"><h3>📅 Por jornadas</h3><div class="hist"><table><thead><tr><th>Participante</th>${js.map(j=>`<th>${esc(new Date(j.fecha+"T12:00").toLocaleDateString(LOC,{day:"numeric",month:"short"}))}</th>`).join("")}</tr></thead><tbody>${filas.map(f=>`<tr><td>${esc(shortName(f.p?.nombre||f.em))}</td>${f.v.map(x=>`<td>${x==null?"–":x}</td>`).join("")}</tr>`).join("")}</tbody></table></div><p class="mini">Desde que el fantasy se juega en la app.</p></div>`;
}
function sparkline(pts){
  if(!pts||pts.length<2) return "";
  const W=90,H=26,min=Math.min(...pts),max=Math.max(...pts),r=max-min||1;
  const xy=pts.map((v,i)=>[2+i*(W-4)/(pts.length-1), H-3-(v-min)/r*(H-6)]);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline points="${xy.map(p=>p.join(",")).join(" ")}"/><circle cx="${xy.at(-1)[0]}" cy="${xy.at(-1)[1]}" r="3"/></svg>`;
}
function mercado(){
  const hist=S.fan?.precioHist||{};
  const filas=fanJugadores().map(p=>{ const h=(hist[p.id]||[]).map(x=>+x.p); const now=precio(p.id); const prev=h.length>1?h.at(-2):null; return {p,now,prev,h}; }).sort((a,b)=>b.now-a.now);
  return `<div class="card"><h3>📈 Mercado</h3>${filas.map(f=>{ const d=f.prev==null?0:Math.round((f.now-f.prev)*10)/10; return `<div class="merc"><span><b>${esc(shortName(f.p.nombre))}</b></span>${sparkline(f.h)}<span>${fmtM(f.now)} ${d?`<span class="${d>0?"up":"down"}">${d>0?"▲":"▼"} ${Math.abs(d).toLocaleString("es-ES")}</span>`:""}</span></div>`; }).join("")}<p class="mini">Precio después de cada jornada.</p></div>`;
}
// Tarjeta para compartir (imagen)
async function tarjetaFantasy(){
  const c=document.createElement("canvas"); c.width=1080; c.height=1350; const g=c.getContext("2d");
  g.fillStyle="#29297a"; g.fillRect(0,0,1080,1350); g.fillStyle="#f03c02"; g.fillRect(0,0,1080,18); g.fillRect(0,1332,1080,18);
  g.fillStyle="#fff"; g.font="800 92px 'Barlow Condensed', 'Arial Narrow', sans-serif"; g.fillText("FANTASY", 80, 170);
  g.font="600 44px Inter, sans-serif"; g.fillStyle="#d7d7f5"; g.fillText((S.aj.nombre||"").toUpperCase(), 80, 235);
  const ult=S.fan?.ultima||{}; let y=340;
  if(ult.mvpNombre){ g.fillStyle="#f03c02"; g.font="700 40px Inter, sans-serif"; g.fillText("MVP · "+(ult.rival||""), 80, y); y+=80; g.fillStyle="#fff"; g.font="800 84px 'Barlow Condensed', sans-serif"; g.fillText("🏆 "+ult.mvpNombre, 80, y); y+=110; }
  g.fillStyle="#f03c02"; g.font="700 40px Inter, sans-serif"; g.fillText("CLASIFICACIÓN", 80, y); y+=30;
  const cl=Object.values(S.fan?.clasificacion||{}).sort((a,b)=>(b.total||0)-(a.total||0)).slice(0,8);
  cl.forEach((x,i)=>{ y+=88; g.fillStyle=i<3?"#fff":"#d7d7f5"; g.font=`${i<3?800:600} 54px Inter, sans-serif`; g.fillText(`${["🥇","🥈","🥉"][i]||(i+1)+"."}  ${shortName(x.nombre)}`, 80, y); g.textAlign="right"; g.fillText(String(Math.round((x.total||0)*10)/10), 1000, y); g.textAlign="left"; });
  const blob=await new Promise(r=>c.toBlob(r,"image/png"));
  const file=new File([blob],"fantasy.png",{type:"image/png"});
  if(navigator.canShare && navigator.canShare({files:[file]})){ try{ await navigator.share({files:[file], title:"Fantasy · "+(S.aj.nombre||"")}); return; }catch{} }
  descargar("fantasy.png", blob, "image/png");
}
// Notas después del partido (para la vuelta)
function notaPartidoHtml(ev){
  if(ev.tipo!=="partido"||!ev.rival||!email()) return "";
  return `<div class="inl"><input type="text" id="np-${esc(ev.id)}" maxlength="300" placeholder="¿Qué funcionó y qué no? (para la vuelta)"><button type="button" class="btn small ghost" data-notapartido="${esc(ev.id)}">📝 Guardar</button></div>`;
}
// Pizarra de jugadas, por pasos. Cada paso guarda dónde está cada ficha y las flechas de lo que pasa en él.
const PZ={modo:"mover", pasos:null, i:0, arrastra:null, trazo:null, abierta:null, anim:null};
const pzCur=()=>PZ.pasos[PZ.i];
// Tipos de trazo: mov = movimiento, bloq = bloqueo, pase, mano = mano a mano, opc = opción (no se ejecuta al pasar de paso)
const PZ_KIND={dibujar:"mov", bloqueo:"bloq", pase:"pase", mano:"mano", tiro:"tiro", opcion:"opc"};
const pzBalon=k=>k==="pase"||k==="mano"||k==="tiro";
const PZ_ARO=[0.5,52/560]; // centro del aro (relativo a la pista)
let PZ_DEF="#29297a";
function pzInicial(){ return {fichas:[...[0.5,0.15,0.85,0.25,0.75].map((x,i)=>({t:"a",n:i+1,x,y:[0.55,0.25,0.25,0.75,0.75][i]})), ...[0.5,0.3,0.7,0.35,0.65].map((x,i)=>({t:"d",n:i+1,x,y:[0.42,0.3,0.3,0.62,0.62][i]})), {t:"b",n:0,x:0.53,y:0.6}], trazos:[]}; }
function pzInit(){ if(!PZ.pasos){ PZ.pasos=[pzInicial()]; PZ.i=0; } pzDraw(); }
const pzCopia=st=>({fichas:st.fichas.map(f=>({...f})), trazos:st.trazos.map(t=>({k:t.k||"mov", p:[...t.p]}))});
// De dónde sale cada flecha: de una ficha, o del final de otra flecha (así se encadenan, p. ej. bloqueo y continuación)
function pzPadre(st,t,c){ if(t.k==="opc") return null; const W=c.width,H=c.height, bal=pzBalon(t.k); let best=null,d=36;
  st.fichas.forEach(f=>{ if(bal!==(f.t==="b")) return; const dd=Math.hypot((f.x-t.p[0])*W,(f.y-t.p[1])*H); if(dd<d){ d=dd; best={f}; } });
  st.trazos.forEach(u=>{ if(u===t||u.k==="opc"||pzBalon(u.k)!==bal) return; const n=u.p.length; const dd=Math.hypot((u.p[n-2]-t.p[0])*W,(u.p[n-1]-t.p[1])*H); if(dd<=d){ d=dd; best={t:u}; } });
  return best; }
// La ficha que sale de cada flecha (siguiendo la cadena hacia atrás)
function pzDueno(st,t,c){ const vistos=new Set(); let x=t;
  while(x && !vistos.has(x)){ vistos.add(x); const p=pzPadre(st,x,c); if(!p) return null; if(p.f) return p.f; x=p.t; } return null; }
// Recorrido completo de una ficha en un paso: sus flechas encadenadas, en orden
function pzCadena(st,f,c){ let t=st.trazos.find(u=>{ const p=pzPadre(st,u,c); return p&&p.f===f; }); if(!t) return null;
  const pts=[...t.p], vistos=new Set([t]);
  for(;;){ const sig=st.trazos.find(u=>!vistos.has(u)&&pzPadre(st,u,c)?.t===t); if(!sig) break; vistos.add(sig); pts.push(...sig.p.slice(2)); t=sig; }
  return pts; }
function pzDraw(st){
  const c=$("#pzCanvas"); if(!c||!PZ.pasos) return; st=st||pzCur(); const g=c.getContext("2d"); const W=c.width,H=c.height;
  const css=getComputedStyle(document.documentElement); const lin=css.getPropertyValue("--muted").trim()||"#888"; const ink=css.getPropertyValue("--ink").trim()||"#17173d";
  g.setLineDash([]); g.globalAlpha=1; PZ_DEF=css.getPropertyValue("--pz-def").trim()||"#29297a";
  g.clearRect(0,0,W,H); g.fillStyle=css.getPropertyValue("--orange-soft").trim()||"#fde7de"; g.fillRect(0,0,W,H);
  g.strokeStyle=lin; g.lineWidth=2;
  g.strokeRect(4,4,W-8,H-8);
  g.strokeRect(W/2-96,4,192,232);
  g.beginPath(); g.arc(W/2,236,72,0,Math.PI); g.stroke();
  g.beginPath(); g.moveTo(40,4); g.lineTo(40,120); g.arc(W/2,52,262,Math.PI-0.34,0.34,true); g.lineTo(W-40,4); g.stroke();
  g.beginPath(); g.arc(W/2,52,14,0,2*Math.PI); g.stroke(); g.beginPath(); g.moveTo(W/2-36,36); g.lineTo(W/2+36,36); g.stroke();
  g.beginPath(); g.arc(W/2,H-4,72,Math.PI,0); g.stroke();
  let nOpc=0;
  const flecha=(t)=>{ const pts=t.p; if(pts.length<4) return; const k=t.k||"mov", opc=k==="opc";
    g.save(); if(opc){ g.strokeStyle=g.fillStyle="#2a6fdb"; g.lineWidth=3; g.globalAlpha=0.85; }
    if(k==="tiro"){ // tiro: línea naranja gruesa hasta el aro, aro marcado y etiqueta «TIRO»
      const ax=PZ_ARO[0]*W, ay=PZ_ARO[1]*H, x0=pts[0]*W, y0=pts[1]*H; g.strokeStyle=g.fillStyle="#f03c02"; g.lineWidth=5;
      g.beginPath(); g.moveTo(x0,y0); g.lineTo(ax,ay); g.stroke();
      g.lineWidth=4; g.beginPath(); g.arc(ax,ay,20,0,2*Math.PI); g.stroke();
      g.font="800 15px Inter, sans-serif"; const w=g.measureText("TIRO").width+16, lx=ax+(x0<ax?-1:1)*(20+w/2+6);
      g.beginPath(); g.roundRect?g.roundRect(lx-w/2,ay-12,w,24,12):g.rect(lx-w/2,ay-12,w,24); g.fill();
      g.fillStyle="#fff"; g.textAlign="center"; g.textBaseline="middle"; g.fillText("TIRO",lx,ay+1); g.restore(); return; }
    g.setLineDash(k==="pase"?[10,9]:opc?[3,8]:[]); g.beginPath(); g.moveTo(pts[0]*W,pts[1]*H); for(let i=2;i<pts.length;i+=2) g.lineTo(pts[i]*W,pts[i+1]*H); g.stroke(); g.setLineDash([]);
    const n=pts.length; const x2=pts[n-2]*W,y2=pts[n-1]*H,x1=pts[Math.max(0,n-6)]*W,y1=pts[Math.max(1,n-5)]*H; const a=Math.atan2(y2-y1,x2-x1);
    if(k==="bloq"){ // bloqueo: barra perpendicular al final
      g.beginPath(); g.moveTo(x2-18*Math.cos(a+Math.PI/2),y2-18*Math.sin(a+Math.PI/2)); g.lineTo(x2+18*Math.cos(a+Math.PI/2),y2+18*Math.sin(a+Math.PI/2)); g.lineWidth=6; g.stroke(); g.restore(); return; }
    if(k==="mano"){ // mano a mano: dos rayas cruzando la línea en el centro
      const mx=(pts[0]*W+x2)/2, my=(pts[1]*H+y2)/2, b=Math.atan2(y2-pts[1]*H,x2-pts[0]*W), px=Math.cos(b+Math.PI/2), py=Math.sin(b+Math.PI/2);
      [-6,6].forEach(o=>{ const cx=mx+o*Math.cos(b), cy=my+o*Math.sin(b); g.beginPath(); g.moveTo(cx-13*px,cy-13*py); g.lineTo(cx+13*px,cy+13*py); g.stroke(); }); }
    g.beginPath(); g.moveTo(x2,y2); g.lineTo(x2-14*Math.cos(a-0.4),y2-14*Math.sin(a-0.4)); g.lineTo(x2-14*Math.cos(a+0.4),y2-14*Math.sin(a+0.4)); g.closePath(); g.fill();
    if(opc){ // etiqueta A, B, C… (o «Tiro» si acaba en el aro)
      const tiro=Math.hypot(x2-W/2,y2-52)<45; const txt=tiro?"Tiro":String.fromCharCode(65+(nOpc++)%26);
      const lx=tiro?x2+18*Math.cos(a):pts[0]*W+(x2-pts[0]*W)*0.62, ly=tiro?y2+18*Math.sin(a):pts[1]*H+(y2-pts[1]*H)*0.62; g.globalAlpha=1; g.font="800 15px Inter, sans-serif"; const w=Math.max(22,g.measureText(txt).width+12);
      g.fillStyle="#2a6fdb"; g.beginPath(); g.roundRect?g.roundRect(lx-w/2,ly-11,w,22,11):g.rect(lx-w/2,ly-11,w,22); g.fill();
      g.fillStyle="#fff"; g.textAlign="center"; g.textBaseline="middle"; g.fillText(txt,lx,ly+1); }
    g.restore(); };
  // Paso anterior en transparente, para ver de dónde viene cada uno
  if(!PZ.anim && PZ.i>0 && st===pzCur()){ g.globalAlpha=0.22; PZ.pasos[PZ.i-1].fichas.forEach(f=>pzFicha(g,f,W,H)); g.globalAlpha=1; }
  g.strokeStyle=g.fillStyle=ink; g.lineWidth=4; g.lineCap="round"; g.lineJoin="round";
  if(!PZ.anim||PZ.anim.pausa){ st.trazos.forEach(flecha); if(PZ.trazo) flecha(PZ.trazo); }
  st.fichas.filter(f=>f.t!=="b").forEach(f=>pzFicha(g,f,W,H)); st.fichas.filter(f=>f.t==="b").forEach(f=>pzFicha(g,f,W,H));
  const tx=$("#pzPaso"); if(tx) tx.textContent=`Paso ${PZ.i+1} de ${PZ.pasos.length}`;
  const ant=$("#pzAnt"), sig=$("#pzSig"), qu=$("#pzQuitar"); if(ant){ ant.disabled=PZ.i===0||!!PZ.anim; sig.disabled=PZ.i>=PZ.pasos.length-1||!!PZ.anim; qu.disabled=PZ.pasos.length<2||!!PZ.anim; }
  const pl=$("#pzPlay"); if(pl){ pl.textContent=PZ.anim?"⏹ Parar":"▶️ Reproducir"; pl.disabled=PZ.pasos.length<2 && !PZ.anim; }
}
function pzFicha(g,f,W,H){ const x=f.x*W,y=f.y*H; g.lineWidth=3; g.setLineDash([]);
  if(f.t==="a"){ g.fillStyle="#f03c02"; g.beginPath(); g.arc(x,y,22,0,2*Math.PI); g.fill(); g.fillStyle="#fff"; g.font="800 24px Inter, sans-serif"; g.textAlign="center"; g.textBaseline="middle"; g.fillText(f.n,x,y+1); }
  else if(f.t==="b"){ g.fillStyle="#f5a623"; g.strokeStyle="#5a3200"; g.lineWidth=2; g.beginPath(); g.arc(x,y,11,0,2*Math.PI); g.fill(); g.stroke(); g.beginPath(); g.moveTo(x-11,y); g.lineTo(x+11,y); g.moveTo(x,y-11); g.lineTo(x,y+11); g.stroke(); }
  else { g.strokeStyle=PZ_DEF; g.lineWidth=5; g.beginPath(); g.moveTo(x-15,y-15); g.lineTo(x+15,y+15); g.moveTo(x+15,y-15); g.lineTo(x-15,y+15); g.stroke(); } }
// Quien lleva el balón (si no hay pase, el balón va con él)
function pzPortador(st,c){ const b=st.fichas.find(f=>f.t==="b"); if(!b||st.trazos.some(t=>pzBalon(t.k)&&pzDueno(st,t,c)===b)) return null;
  let best=null,d=40; st.fichas.forEach(f=>{ if(f.t!=="a") return; const dd=Math.hypot((f.x-b.x)*c.width,(f.y-b.y)*c.height); if(dd<d){ d=dd; best=f; } }); return best?{b,f:best}:null; }
// Nuevo paso: las fichas con flecha ya aparecen donde acaba su flecha
function pzNuevoPaso(){ const c=$("#pzCanvas"); const st=pzCur(); const nx=pzCopia(st); nx.trazos=[];
  st.fichas.forEach((f,j)=>{ const r=pzCadena(st,f,c); if(!r) return; nx.fichas[j].x=r[r.length-2]; nx.fichas[j].y=r[r.length-1]; });
  const po=pzPortador(st,c); if(po){ const nf=nx.fichas[st.fichas.indexOf(po.f)], nb=nx.fichas[st.fichas.indexOf(po.b)]; nb.x=Math.min(1,Math.max(0,po.b.x+nf.x-po.f.x)); nb.y=Math.min(1,Math.max(0,po.b.y+nf.y-po.f.y)); }
  PZ.pasos.splice(PZ.i+1,0,nx); PZ.i++; pzDraw(); }
// Reproducir: cada ficha recorre su flecha (o va en línea recta) hasta el siguiente paso
function pzRuta(a,b,f0,f1,c){ const r=pzCadena(a,f0,c); const fin=[f1.x,f1.y];
  if(r && Math.hypot((r[r.length-2]-f1.x)*c.width,(r[r.length-1]-f1.y)*c.height)<40) return [f0.x,f0.y,...r.slice(2,-2),...fin];
  return [f0.x,f0.y,...fin]; }
function pzEnRuta(r,u){ const seg=[]; let tot=0; for(let i=0;i+3<r.length;i+=2){ const l=Math.hypot(r[i+2]-r[i],r[i+3]-r[i+1]); seg.push(l); tot+=l; }
  if(!tot) return [r[0],r[1]]; let d=u*tot; for(let i=0,k=0;k<seg.length;i+=2,k++){ if(d<=seg[k]||k===seg.length-1){ const q=seg[k]?Math.min(1,d/seg[k]):1; return [r[i]+(r[i+2]-r[i])*q, r[i+1]+(r[i+3]-r[i+1])*q]; } d-=seg[k]; } return [r[r.length-2],r[r.length-1]]; }
function pzPlay(){ if(PZ.anim){ cancelAnimationFrame(PZ.anim.raf); PZ.anim=null; pzDraw(); return; }
  const c=$("#pzCanvas"); const P=PZ.pasos; let k=0, t0=null; const DUR=1300, PAUSA=700; PZ.anim={raf:0};
  const tick=ts=>{ if(!PZ.anim) return; if(t0===null) t0=ts; const el=ts-t0;
    if(k>=P.length-1){ PZ.anim=null; PZ.i=P.length-1; pzDraw(); return; }
    const a=P[k], b=P[k+1];
    if(el<PAUSA){ PZ.anim.pausa=true; PZ.i=k; pzDraw(a); }
    else { PZ.anim.pausa=false; const u=Math.min(1,(el-PAUSA)/DUR), e=u<.5?2*u*u:1-Math.pow(-2*u+2,2)/2;
      const po=pzPortador(a,c);
      const st={fichas:a.fichas.map((f,j)=>{ const f1=b.fichas[j]||f; const [x,y]=pzEnRuta(pzRuta(a,b,f,f1,c),e); return {...f,x,y}; }), trazos:[]};
      if(po){ const jf=a.fichas.indexOf(po.f), jb=a.fichas.indexOf(po.b), bf=b.fichas[jb];
        if(bf && Math.hypot((bf.x-(po.b.x+b.fichas[jf].x-po.f.x))*c.width,(bf.y-(po.b.y+b.fichas[jf].y-po.f.y))*c.height)<30){ st.fichas[jb].x=po.b.x+st.fichas[jf].x-po.f.x; st.fichas[jb].y=po.b.y+st.fichas[jf].y-po.f.y; } }
      pzDraw(st); if(u>=1){ k++; t0=ts; } }
    PZ.anim.raf=requestAnimationFrame(tick); };
  PZ.anim.raf=requestAnimationFrame(tick); pzDraw(); }
function pzPos(e){ const c=$("#pzCanvas"), r=c.getBoundingClientRect(); return {x:Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)), y:Math.min(1,Math.max(0,(e.clientY-r.top)/r.height))}; }
(function(){ const c=$("#pzCanvas"); if(!c) return;
  c.addEventListener("pointerdown",e=>{ if(PZ.anim||!PZ.pasos) return; c.setPointerCapture(e.pointerId); const p=pzPos(e);
    if(PZ.modo==="mover"){ const fs=pzCur().fichas; PZ.arrastra=[...fs.filter(f=>f.t==="b"),...fs.filter(f=>f.t!=="b").reverse()].find(f=>Math.hypot((f.x-p.x)*c.width,(f.y-p.y)*c.height)<(f.t==="b"?22:30))||null; }
    else PZ.trazo={k:PZ_KIND[PZ.modo]||"mov", p:[+p.x.toFixed(3),+p.y.toFixed(3)]}; });
  c.addEventListener("pointermove",e=>{ const p=pzPos(e); if(PZ.arrastra){ PZ.arrastra.x=p.x; PZ.arrastra.y=p.y; pzDraw(); } else if(PZ.trazo){ const q=PZ.trazo.p, n=q.length; if(Math.hypot((q[n-2]-p.x)*c.width,(q[n-1]-p.y)*c.height)>8){ q.push(+p.x.toFixed(3),+p.y.toFixed(3)); pzDraw(); } } });
  const fin=()=>{ if(PZ.trazo && PZ.trazo.p.length>=4){ if(PZ.trazo.k==="tiro"){ const q=PZ.trazo.p; PZ.trazo.p=[q[0],q[1],PZ_ARO[0],+PZ_ARO[1].toFixed(3)]; } else if(pzBalon(PZ.trazo.k)){ const q=PZ.trazo.p; PZ.trazo.p=[q[0],q[1],q[q.length-2],q[q.length-1]]; } pzCur().trazos.push(PZ.trazo); } PZ.trazo=null; PZ.arrastra=null; pzDraw(); };
  c.addEventListener("pointerup",fin); c.addEventListener("pointercancel",fin);
})();
function pzDatos(){ return PZ.pasos.map(st=>({fichas:st.fichas.map(f=>({t:f.t,n:f.n,x:+(+f.x).toFixed(3),y:+(+f.y).toFixed(3)})), trazos:st.trazos.map(t=>({k:t.k||"mov",p:t.p}))})); }
function pzCargar(j){ const pasos=j.pasos?.length?j.pasos:[{fichas:j.fichas||[],trazos:(j.trazos||[]).map(x=>({k:"mov",p:x.p}))}];
  PZ.pasos=pasos.map(st=>{ const c=pzCopia({fichas:st.fichas||[],trazos:st.trazos||[]}); if(!c.fichas.some(f=>f.t==="b")) c.fichas.push({t:"b",n:0,x:0.53,y:0.6}); return c; }); PZ.i=0; PZ.abierta={id:j.id,nombre:j.nombre}; }
function renderPizarra(){
  if(!$("#pzLista")) return;
  $("#pzGuardarRow").hidden=!S.canWrite;
  const l=[...(S.jugadas||[])].sort((a,b)=>(b.creado||0)-(a.creado||0));
  $("#pzLista").innerHTML = l.length ? l.map(j=>`<li class="gasto"><span><b>${esc(j.nombre)}</b> <span class="mini">· ${j.pasos?.length||1} ${(j.pasos?.length||1)===1?"paso":"pasos"} · ${esc(shortName(j.autor))}</span></span><span class="row"><button type="button" class="btn small" data-pzabrir="${esc(j.id)}">Abrir</button>${S.canWrite?`<button type="button" class="btn small danger" data-pzdel="${esc(j.id)}">✕</button>`:""}</span></li>`).join("") : '<li class="note">Todavía no hay jugadas guardadas.</li>';
}
// Idiomas: traducción de los textos fijos de la app (menús, títulos y botones)
const I18N={
 va:{"Resumen":"Resum","Historial":"Historial","Asistencia":"Assistència","Multa":"Multa","Scouting":"Scouting","Planes":"Plans","Ajustes":"Ajustos","Equipo":"Equip","Clasificación de multas":"Classificació de multes","Bote total":"Pot total","Por cobrar":"Per cobrar","Cobrado":"Cobrat","Poner multa":"Posar multa","Próximos":"Pròxims","Anteriores":"Anteriors","Voy":"Vaig","No voy":"No vaig","Guardar":"Guardar","Borrar":"Esborrar","Quitar":"Llevar","Cancelar":"Cancel·lar","Pasar lista":"Passar llista","Avisar a todos ahora":"Avisar a tots ara","Crear":"Crear","Tus multas":"Les teues multes","Ver mis multas":"Veure les meues multes","Copiar resumen para WhatsApp":"Copiar resum per a WhatsApp","Manual de uso":"Manual d'ús","Cuenta":"Compte","Administradores":"Administradors","Tipos de multa":"Tipus de multa","Avisos":"Avisos","Activar notificaciones":"Activar notificacions","Plantilla":"Plantilla","Añadir":"Afegir","Entrar":"Entrar","Salir":"Eixir","Crear cuenta":"Crear compte","Días que no puedo ir":"Dies que no puc anar","Guardar mis días":"Guardar els meus dies","Nuevo entreno o partido":"Nou entrenament o partit","Entreno":"Entrenament","Partido":"Partit","Cobrada":"Cobrada","Pendiente":"Pendent","Pantalla":"Pantalla","Letra más grande":"Lletra més gran","Idioma":"Idioma","Sugerir una mejora":"Suggerir una millora","Enviar sugerencia":"Enviar suggeriment","Fantasy":"Fantasy","Reglas":"Regles","Clasificación":"Classificació","Mercado":"Mercat","Pizarra":"Pissarra","Liga · clasificación y resultados":"Lliga · classificació i resultats","Nuestros resultados":"Els nostres resultats","Pagos":"Pagaments","Cobrar":"Cobrar","Descargar en Excel":"Descarregar en Excel","Registro de cambios":"Registre de canvis","El bote":"El pot","Convocar":"Convocar","Cómo llegar":"Com arribar","Lista":"Llista","Calendario":"Calendari","Esta temporada":"Esta temporada","Volver":"Tornar","Privacidad y datos":"Privacitat i dades"},
 en:{"Resumen":"Summary","Historial":"History","Asistencia":"Attendance","Multa":"Fine","Scouting":"Scouting","Planes":"Plans","Ajustes":"Settings","Equipo":"Team","Clasificación de multas":"Fines ranking","Bote total":"Total pot","Por cobrar":"To collect","Cobrado":"Collected","Poner multa":"Add fine","Próximos":"Upcoming","Anteriores":"Past","Voy":"I'm in","No voy":"Can't go","Guardar":"Save","Borrar":"Delete","Quitar":"Remove","Cancelar":"Cancel","Pasar lista":"Take attendance","Avisar a todos ahora":"Notify everyone now","Crear":"Create","Tus multas":"Your fines","Ver mis multas":"See my fines","Copiar resumen para WhatsApp":"Copy summary for WhatsApp","Manual de uso":"User guide","Cuenta":"Account","Administradores":"Admins","Tipos de multa":"Fine types","Avisos":"Notices","Activar notificaciones":"Turn on notifications","Plantilla":"Roster","Añadir":"Add","Entrar":"Sign in","Salir":"Sign out","Crear cuenta":"Create account","Días que no puedo ir":"Days I can't make it","Guardar mis días":"Save my days","Nuevo entreno o partido":"New practice or game","Entreno":"Practice","Partido":"Game","Cobrada":"Paid","Pendiente":"Pending","Pantalla":"Display","Letra más grande":"Larger text","Idioma":"Language","Sugerir una mejora":"Suggest an improvement","Enviar sugerencia":"Send suggestion","Fantasy":"Fantasy","Reglas":"Rules","Clasificación":"Standings","Mercado":"Market","Pizarra":"Playbook","Liga · clasificación y resultados":"League · standings and results","Nuestros resultados":"Our results","Pagos":"Payments","Cobrar":"Collect","Descargar en Excel":"Download for Excel","Registro de cambios":"Change log","El bote":"The pot","Convocar":"Call up","Cómo llegar":"Directions","Lista":"List","Calendario":"Calendar","Esta temporada":"This season","Volver":"Back","Privacidad y datos":"Privacy and data"}
};
let lang=store.get("multas.idioma","es"), traduciendo=false;
const ORIG=new WeakMap(), ORIGA=new WeakMap();
const normI=s=>s.replace(/\s+/g," ").trim();
function claveI(s){ const k=normI(s); const m=k.match(/^[^\p{L}]*/u)[0]; return [m, k.slice(m.length).trim()]; }
function trTexto(o,dic){
  const k=o.trim(); if(!k) return null;
  const [pre,limpio]=claveI(k); let tr=dic[limpio];
  if(!tr && /[.:]$/.test(limpio)){ const b=dic[limpio.slice(0,-1)]; if(b) tr=b+limpio.slice(-1); }
  if(!tr) for(const [re,f] of (I18N_RE[lang]||[])){ const m=limpio.match(re); if(m){ tr=f(m); break; } }
  if(!tr) return null;
  return o.replace(k, pre.replace(/[¿¡]/g,"")+tr);
}
fetch("i18n.json").then(r=>r.json()).then(d=>{ for(const l of ["va","en"]) Object.assign(I18N[l], d[l], {...I18N[l]}); if(lang!=="es") traducir(); }).catch(()=>{});
function traducir(root=document.body){
  if(lang==="es" && !root.__trad) return;
  const dic=I18N[lang]||{}; traduciendo=true;
  const base=root.nodeType===3?root.parentElement:root; if(!base){ traduciendo=false; return; }
  const w=document.createTreeWalker(base, NodeFilter.SHOW_TEXT);
  for(let n; (n=w.nextNode());){
    if(n.parentElement?.closest("textarea,script,style,#histList .t,.nota,.aviso p,.sug p,[data-noi18n]")) continue;
    const g=ORIG.get(n); const o=(g && n.nodeValue===g.r)?g.o:n.nodeValue;
    const r=lang==="es"?null:trTexto(o,dic);
    if(r){ ORIG.set(n,{o,r}); if(n.nodeValue!==r) n.nodeValue=r; }
  }
  if(base.querySelectorAll) for(const el of [base,...base.querySelectorAll("[placeholder],[title],[aria-label]")]){
    if(!el.getAttribute) continue;
    const g=ORIGA.get(el)||{}; let cambio=false;
    for(const a of ["placeholder","title","aria-label"]){ const v=g[a]??el.getAttribute(a); if(!v) continue; const r=trTexto(v,dic); if(r){ g[a]=v; cambio=true; if(el.getAttribute(a)!==r) el.setAttribute(a,r); } }
    if(cambio) ORIGA.set(el,g);
  }
  document.body.__trad=true; traduciendo=false;
}
// Frases que cambian (números, nombres, fechas)
const I18N_RE={
  va:[[/^Debe (.+)$/,m=>"Deu "+m[1]],[/^Contesta antes de (.+)$/,m=>"Contesta abans de "+m[1]],[/^(\d+) multas?$/,m=>m[1]+(m[1]==="1"?" multa":" multes")],[/^(\d+) jugadores$/,m=>m[1]+" jugadors"],[/^Jornada (\d+)$/,m=>"Jornada "+m[1]],[/^Guardado$/,()=>"Guardat"],[/^Hecho$/,()=>"Fet"],[/^Sin conexión.*$/,()=>"Sense connexió"],[/^(\d+) van?$/,m=>m[1]+" van"],[/^(\d+) no van?$/,m=>m[1]+" no van"],[/^Paso (\d+) de (\d+)$/,m=>`Pas ${m[1]} de ${m[2]}`],[/^Jugada guardada \((\d+) pasos?\)$/,m=>`Jugada guardada (${m[1]} ${m[1]==="1"?"pas":"passos"})`],[/^Jugada: (.+)$/,m=>"Jugada: "+m[1]],[/^Última: (.+)$/,m=>"Última: "+m[1]],[/^(\d+) pasos?( · .*)?$/,m=>m[1]+(m[1]==="1"?" pas":" passos")+(m[2]||"")]],
  en:[[/^Debe (.+)$/,m=>"Owes "+m[1]],[/^Contesta antes de (.+)$/,m=>"Answer before "+m[1]],[/^(\d+) multas?$/,m=>m[1]+(m[1]==="1"?" fine":" fines")],[/^(\d+) jugadores$/,m=>m[1]+" players"],[/^Jornada (\d+)$/,m=>"Round "+m[1]],[/^Guardado$/,()=>"Saved"],[/^Hecho$/,()=>"Done"],[/^Sin conexión.*$/,()=>"Offline"],[/^(\d+) van?$/,m=>m[1]+" going"],[/^(\d+) no van?$/,m=>m[1]+" not going"],[/^Paso (\d+) de (\d+)$/,m=>`Step ${m[1]} of ${m[2]}`],[/^Jugada guardada \((\d+) pasos?\)$/,m=>`Play saved (${m[1]} ${m[1]==="1"?"step":"steps"})`],[/^Jugada: (.+)$/,m=>"Play: "+m[1]],[/^Última: (.+)$/,m=>"Last: "+m[1]],[/^(\d+) pasos?( · .*)?$/,m=>m[1]+(m[1]==="1"?" step":" steps")+(m[2]||"")]]
};
const obsI18n=new MutationObserver(ms=>{ if(traducir&&!traduciendo&&lang!=="es") ms.forEach(m=>{ if(m.type==="characterData") traducir(m.target); else m.addedNodes.forEach(nd=>{ if(nd.nodeType===1||nd.nodeType===3) traducir(nd); }); }); });
obsI18n.observe(document.body,{childList:true,subtree:true,characterData:true});
$("#idioma").value=lang; $("#idiomaNota").hidden=lang==="es";
$("#idioma").addEventListener("change",e=>{ lang=e.target.value; store.set("multas.idioma",lang); $("#idiomaNota").hidden=lang==="es"; document.documentElement.lang=lang==="va"?"ca":lang; location.reload(); });
if(lang!=="es"){ document.documentElement.lang=lang==="va"?"ca":lang; setTimeout(()=>traducir(),300); }

function handleTanda2(t,d){
  if(d.vista){ const cal=d.vista==="cal"; $("#calBox").hidden=!cal; $("#vistaCal").setAttribute("aria-pressed",cal); $("#vistaLista").setAttribute("aria-pressed",!cal); renderCal(); return true; }
  if(d.calnav){ calMes=new Date(calMes.getFullYear(), calMes.getMonth()+(+d.calnav), 1); calDia=null; renderCal(); return true; }
  if(d.caldia){ calDia = calDia===d.caldia?null:d.caldia; renderCal(); return true; }
  if(d.ficha){ abrirFicha(d.ficha); return true; }
  if(t.id==="fanMercado"){ S.verMercado=!S.verMercado; renderFantasy(); return true; }
  if(t.id==="fanTarjeta"){ tarjetaFantasy(); return true; }
  if(d.notapartido){ const ev=evById(d.notapartido); const i=document.getElementById("np-"+d.notapartido); const v=(i?.value||"").trim(); if(!v){ toast("Escribe la nota"); return true; }
    i.value=""; i.blur();
    run(()=>F.addDoc(F.collection(db,"equipos",TEAM,"rivales",ev.rival,"notas"),{jugador:"", partido:ev.id, texto:("Tras el partido del "+new Date(ev.fecha+"T12:00").toLocaleDateString(LOC,{day:"numeric",month:"short"})+": "+v).slice(0,500), autor:email(), nombre:myName(), creado:Date.now(), notificada:false}),"Nota guardada en el scouting del rival"); return true; }
  if(d.pzmodo){ PZ.modo=d.pzmodo; document.querySelectorAll("[data-pzmodo]").forEach(b=>b.setAttribute("aria-pressed",b.dataset.pzmodo===PZ.modo)); return true; }
  if(t.id==="fbcvHecho"){ const hoy=new Date(); const ymd=hoy.getFullYear()+"-"+String(hoy.getMonth()+1).padStart(2,"0")+"-"+String(hoy.getDate()).padStart(2,"0");
    run(()=>F.updateDoc(F.doc(db,"equipos",LEGACY_TEAM),{fbcvRenovado:ymd}),"Hecho. No te llegarán más recordatorios esta semana").then(()=>fbcvFecha()); return true; }
  if(t.id==="pzDeshacer"){ if(PZ.anim) return true; pzCur().trazos.pop(); pzDraw(); return true; }
  if(t.id==="pzLimpiar"){ armed(t,"⚠️ ¿Borrar toda la pizarra? Pulsa otra vez",()=>{ if(PZ.anim) pzPlay(); PZ.pasos=null; PZ.abierta=null; $("#pzNombre").value=""; pzInit(); toast("Pizarra vacía"); }); return true; }
  if(t.id==="pzNuevo"){ if(!PZ.anim) pzNuevoPaso(); return true; }
  if(t.id==="pzAnt"){ if(PZ.i>0){ PZ.i--; pzDraw(); } return true; }
  if(t.id==="pzSig"){ if(PZ.i<PZ.pasos.length-1){ PZ.i++; pzDraw(); } return true; }
  if(t.id==="pzQuitar"){ if(PZ.pasos.length>1){ armed(t,"¿Quitar este paso?",()=>{ PZ.pasos.splice(PZ.i,1); PZ.i=Math.min(PZ.i,PZ.pasos.length-1); pzDraw(); }); } return true; }
  if(t.id==="pzPlay"){ pzPlay(); return true; }
  if(t.id==="pzGuardar"){ const nombre=$("#pzNombre").value.trim(); if(!nombre){ toast("Ponle un nombre a la jugada"); return true; }
    const datos={nombre, pasos:pzDatos(), autor:myName(), creado:Date.now()};
    const misma=PZ.abierta && PZ.abierta.nombre===nombre;
    run(()=>misma?F.setDoc(F.doc(col("jugadas"),PZ.abierta.id),datos):F.addDoc(col("jugadas"),datos).then(r=>{ PZ.abierta={id:r.id,nombre}; return r; }), misma?"Jugada actualizada":`Jugada guardada (${PZ.pasos.length} ${PZ.pasos.length===1?"paso":"pasos"})`); return true; }
  if(d.pzabrir){ const j=(S.jugadas||[]).find(x=>x.id===d.pzabrir); if(j){ if(PZ.anim) pzPlay(); pzCargar(j); $("#pzNombre").value=j.nombre||""; pzDraw(); window.scrollTo({top:0,behavior:"smooth"}); toast("Jugada: "+j.nombre); } return true; }
  if(d.pzdel){ armed(t,"¿Borrar?",()=>run(()=>F.deleteDoc(F.doc(col("jugadas"),d.pzdel)),"Jugada borrada")); return true; }
  return false;
}

/* ---------- conexión con los datos ---------- */
function setStatus(msg){ const s=$("#status"); s.hidden=!msg; s.textContent=msg||""; }
let unsubs=[];
function subscribe(){
  unsubs.forEach(u=>u()); unsubs=[];
  const timer=setTimeout(()=>{ if(!S.ready.m) setStatus("Sin conexión: se muestran los últimos datos guardados en el móvil."); },10000);
  const done=snap=>{ if(!snap.metadata.fromCache){ clearTimeout(timer); setStatus(""); } };
  const fail=e=>{ console.error(e); clearTimeout(timer); setStatus("No se pueden leer los datos: "+errMsg(e)); };
  let firstMultas=true;
  unsubs.push(F.onSnapshot(col("jugadores"), s=>{ S.jug=s.docs.map(d=>({id:d.id,...d.data()})); S.ready.j=true; done(s);
    const mid=myPlayer()?.id||""; if(mid!==S.meId){ S.meId=mid; syncTokenPrefs(); }
    renderAll(); }, fail));
  fanUnsubs.forEach(u=>u()); fanUnsubs=[]; fanJornadaId=null;
  unsubs.push(F.onSnapshot(col("jugadas"), s=>{ S.jugadas=s.docs.map(d=>({id:d.id,...d.data()})); renderPizarra(); }, e=>console.warn(e)));
  unsubs.push(F.onSnapshot(col("jornadas"), s=>{ S.fanJornadas=s.docs.map(d=>({id:d.id,...d.data()})); renderFantasy(); }, e=>console.warn(e)));
  unsubs.push(F.onSnapshot(col("gastos"), s=>{ S.gastos=s.docs.map(d=>({id:d.id,...d.data()})); renderBote(); }, fail));
  unsubs.push(F.onSnapshot(F.query(col("registro"), F.orderBy("creado","desc"), F.limit(60)), s=>{ S.registro=s.docs.map(d=>({id:d.id,...d.data()})); renderLog(); }, e=>console.warn(e)));
  unsubs.push(F.onSnapshot(col("planes"), s=>{ S.planes=s.docs.map(d=>({id:d.id,...d.data()})); syncPlanListeners(); renderPlanes(); }, fail));
  unsubs.push(F.onSnapshot(col("rivales"), s=>{ S.rivales=s.docs.map(d=>({id:d.id,...d.data()})); renderScouting(); renderAsis(); }, fail));
  let firstAv=true;
  unsubs.push(F.onSnapshot(col("avisos"), s=>{
    S.avisos=s.docs.map(d=>({id:d.id,...d.data()}));
    if(!firstAv){ const nuevos=s.docChanges().filter(c=>c.type==="added"&&!c.doc.metadata.hasPendingWrites).map(c=>c.doc.data()).filter(a=>a.autor!==S.user?.uid);
      if(nuevos.length) toast("📣 "+nuevos[0].texto.slice(0,90)); }
    if(!s.metadata.fromCache) firstAv=false;
    renderAvisos(); }, fail));
  unsubs.push(F.onSnapshot(col("eventos"), s=>{ S.eventos=s.docs.map(d=>({id:d.id,...d.data()})); S.ready.e=true; done(s); renderAsis(); renderHeader(); fanSync(); }, fail));
  unsubs.push(F.onSnapshot(col("tipos"), s=>{ S.tipos=s.docs.map(d=>({id:d.id,...d.data()})); S.ready.t=true; done(s); renderAll(); }, fail));
  unsubs.push(F.onSnapshot(teamRef(), s=>{
    if(!s.exists()){
      if(s.metadata.fromCache) return;
      toast("No existe ningún equipo con el código "+TEAM); leaveTeam(); return;
    }
    S.aj=Object.assign({nombre:"",inicio:"",contador:"",admins:[],escudo:"",viernes:false}, s.data());
    setTimeout(fanSync,0);
    rememberTeam(TEAM, S.aj.nombre);
    if(!S.aj.propietario && S.aj.creador && S.user && S.user.uid===S.aj.creador && email() && !S.ownerClaimed){
      S.ownerClaimed=true; F.updateDoc(teamRef(),{propietario:email()}).catch(e=>console.warn("propietario",e));
    }
    if(!s.metadata.hasPendingWrites) ajFilled=false;
    computeWrite(); S.ready.a=true; done(s); renderAll(); }, fail));
  unsubs.push(F.onSnapshot(col("multas"), s=>{
    S.multas=s.docs.map(d=>({id:d.id,...d.data()}));
    if(!firstMultas && S.prefs.live){
      const added=s.docChanges().filter(c=>c.type==="added" && !c.doc.metadata.hasPendingWrites).map(c=>c.doc.data()).filter(m=>m.autor!==S.user?.uid);
      if(added.length===1){ const m=added[0]; toast("Nueva multa: "+(m.jugadorNombre||"")+" · "+m.tipoNombre+" · "+eur(m.importe)); }
      else if(added.length>1) toast(added.length+" multas nuevas apuntadas");
    }
    if(!s.metadata.fromCache) firstMultas=false;
    S.ready.m=true; done(s); renderAll();
  }, fail));
}

/* ---------- equipos: entrar, crear, cambiar ---------- */
function resetTeamState(){
  unsubs.forEach(u=>u()); unsubs=[];
  planUnsubs.forEach(u=>u()); planUnsubs.clear(); if(rivUnsub){ rivUnsub(); rivUnsub=null; }
  Object.assign(S,{jug:[],tipos:[],multas:[],eventos:[],avisos:[],showAllAv:false,openEv:null,planes:[],planResp:{},planProp:{},openPlan:null,rivales:[],rivNotas:[],rivalOpen:"",aj:{nombre:"",inicio:"",contador:"",admins:[],escudo:"",viernes:false},ready:{j:false,t:false,m:false,a:false},canWrite:false,selType:null,openRank:null,meId:undefined});
  S.selPlayers=new Set(); ajFilled=false;
}
function rememberTeam(id, nombre){
  const list=store.get("multas.teams",[]).filter(t=>t.id!==id);
  list.unshift({id, nombre:nombre||id}); store.set("multas.teams", list.slice(0,8));
}
function openTeam(id){
  resetTeamState();
  TEAM=id; teamOpen=true; store.set("multas.team",id);
  S.lastSeen = store.get("multas.lastSeen."+id, id===LEGACY_TEAM ? store.get("multas.lastSeen",0) : 0);
  try{ history.replaceState(null,"",location.pathname+"?e="+id+location.hash); }catch{}
  if(S.user){ subscribe(); syncTokenPrefs(); F.setDoc(F.doc(db,"usuarios",S.user.uid),{equipos:F.arrayUnion(id)},{merge:true}).catch(()=>{}); }
  route(); renderAll();
}
function leaveTeam(){
  resetTeamState(); teamOpen=false; TEAM=""; store.set("multas.team","");
  try{ history.replaceState(null,"",location.pathname); }catch{}
  route(); renderAll(); renderLanding();
}
let landingFor=null;
async function renderLanding(){
  if(teamOpen) return;
  const e=email();
  $("#createLogin").hidden=!!e; $("#createForm").hidden=!e;
  $("#createWho").textContent = e ? "Serás el administrador del equipo nuevo ("+e+")." : "";
  const recent=store.get("multas.teams",[]);
  let ids=recent.map(t=>t.id); const names=Object.fromEntries(recent.map(t=>[t.id,t.nombre]));
  if(S.user && landingFor!==S.user.uid){
    landingFor=S.user.uid;
    try{ const u=await F.getDoc(F.doc(db,"usuarios",S.user.uid)); (u.data()?.equipos||[]).forEach(id=>{ if(!ids.includes(id)) ids.push(id); }); }catch{}
    for(const id of ids.filter(id=>!names[id]||names[id]===id)){ try{ const t=await F.getDoc(F.doc(db,"equipos",id)); if(t.exists()) names[id]=t.data().nombre; else ids=ids.filter(x=>x!==id); }catch{} }
    S.landTeams={ids,names};
    // Migración del equipo de antes al sistema de varios equipos
    $("#migrateCard").hidden=true;
    if(e){ try{
      const leg=await F.getDoc(F.doc(db,"ajustes","general"));
      const isLegAdmin = leg.exists() && (leg.data().admins||[]).map(x=>String(x).toLowerCase()).includes(e);
      if(isLegAdmin){ const t=await F.getDoc(F.doc(db,"equipos",LEGACY_TEAM)); $("#migrateCard").hidden = t.exists(); }
    }catch{} }
  }
  const L=S.landTeams||{ids,names};
  $("#myTeamsCard").hidden=!L.ids.length;
  $("#myTeams").innerHTML=L.ids.map(id=>`<div class="prow"><span class="who"><b>${esc(L.names[id]||id)}</b><span>Código ${esc(id)}</span></span><button type="button" class="btn small" data-open="${esc(id)}">Abrir</button></div>`).join("");
}
async function createTeam(){
  const nombre=$("#ctName").value.trim(); if(!nombre){ toast("Escribe el nombre del equipo"); return; }
  const btn=$("#ctBtn"); btn.disabled=true;
  try{
    let id=genCode();
    for(let i=0;i<5;i++){ const t=await F.getDoc(F.doc(db,"equipos",id)); if(!t.exists()) break; id=genCode(); }
    const b=F.writeBatch(db);
    b.set(F.doc(db,"equipos",id),{nombre, admins:[email()], contador:$("#ctCount").value.trim(), inicio:"", viernes:false, escudo:"", creado:Date.now(), creador:S.user.uid, propietario:email()});
    if($("#ctSample").checked) DEFAULT_TYPES.forEach(([n,precio,unidad],i)=>b.set(F.doc(db,"equipos",id,"tipos","t"+(i+1)),{nombre:n,precio,unidad,orden:i+1}));
    if(await run(()=>b.commit(),"Equipo creado: "+nombre)){ rememberTeam(id,nombre); location.hash="equipo"; openTeam(id); }
  } finally { btn.disabled=false; }
}
async function migrateLegacy(){
  const btn=$("#migrateBtn"); btn.disabled=true; btn.textContent="Pasando los datos…";
  try{
    const L=(await F.getDoc(F.doc(db,"ajustes","general"))).data()||{};
    let escudo=""; try{ const blob=await (await fetch("icons/escudo-128.png")).blob(); escudo=await new Promise(r=>{ const fr=new FileReader(); fr.onload=()=>r(fr.result); fr.readAsDataURL(blob); }); }catch{}
    const ok=await run(()=>F.setDoc(F.doc(db,"equipos",LEGACY_TEAM),{nombre:"Caixa Ontinyent", admins:L.admins||[email()], contador:L.contador||"", inicio:L.inicio||"", viernes:true, escudo, creado:Date.now(), creador:S.user.uid, propietario:email()}));
    if(!ok) return;
    for(const c of ["jugadores","tipos","multas"]){
      const snap=await F.getDocs(F.collection(db,c));
      let b=F.writeBatch(db), n=0;
      for(const d of snap.docs){ const data={...d.data()}; if(c==="multas") data.notificada=true; b.set(F.doc(db,"equipos",LEGACY_TEAM,c,d.id),data); if(++n%400===0){ await b.commit(); b=F.writeBatch(db); } }
      await b.commit();
    }
    toast("Equipo pasado al sistema nuevo"); rememberTeam(LEGACY_TEAM,"Caixa Ontinyent"); openTeam(LEGACY_TEAM);
  }catch(e){ console.error(e); toast(errMsg(e)); }
  finally{ btn.disabled=false; btn.textContent="Pasar Caixa Ontinyent al sistema nuevo"; }
}
async function setCrest(file){
  try{
    const img=await createImageBitmap(file);
    const k=Math.min(1,128/Math.max(img.width,img.height));
    const c=document.createElement("canvas"); c.width=Math.round(img.width*k); c.height=Math.round(img.height*k);
    c.getContext("2d").drawImage(img,0,0,c.width,c.height);
    let url=c.toDataURL("image/png"); if(url.length>150000) url=c.toDataURL("image/jpeg",0.85);
    await run(()=>F.updateDoc(teamRef(),{escudo:url}),"Escudo guardado");
  }catch(e){ console.error(e); toast("No se pudo leer esa imagen. Prueba con un PNG o JPG."); }
}
function inviteText(){
  return ["🏀 *Multas · "+(S.aj.nombre||"equipo")+"*", "Entra en la app: "+teamLink(TEAM),
    "📱 *iPhone:* en Safari → Compartir ⬆️ → *Añadir a pantalla de inicio*",
    "🤖 *Android:* en Chrome → *Instalar*",
    "👤 *Ajustes → Cuenta → Crear cuenta*, y en *Resumen* elige tu nombre → *Soy yo*",
    "🔔 *Ajustes → Avisos → Activar notificaciones*"].join("\n");
}

let lastUid=null;
A.onAuthStateChanged(auth, async u=>{
  if(!u){ A.signInAnonymously(auth).catch(e=>setStatus("No se puede conectar: "+errMsg(e)+". Revisa que el acceso anónimo esté activado (GUIA.md).")); return; }
  S.user=u; computeWrite();
  if(u.uid!==lastUid){
    lastUid=u.uid;
    if(!TEAM && legacyDevice){ try{ const t=await F.getDoc(F.doc(db,"equipos",LEGACY_TEAM)); if(t.exists()) TEAM=LEGACY_TEAM; }catch{} }
    if(TEAM) openTeam(TEAM); else { teamOpen=false; route(); }
  }
  renderAll(); renderLanding(); initSugerencias();
});

if("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(e=>console.warn("SW",e));
$("#fecha").value=today();
route(); renderInstall(); renderAll(); renderLanding();
if(store.get("multas.pushToken","")) listenForeground();
