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
const eur = n => (Math.round((+n||0)*100)/100).toLocaleString("es-ES",{maximumFractionDigits:2}) + " €";
const pad = n => String(n).padStart(2,"0");
const today = () => { const d=new Date(); return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate()); };
const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
const monthName = ym => { if(!ym) return ""; const [y,m]=ym.split("-"); return MESES[+m-1]+" de "+y; };
const dayName = ymd => { try{ const [y,m,d]=ymd.split("-").map(Number); return new Date(y,m-1,d).toLocaleDateString("es-ES",{weekday:"long",day:"numeric",month:"long"}); }catch{ return ymd; } };
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
  jug: [], tipos: [], multas: [], aj: {nombre:"", inicio:"", contador:"", admins:[], escudo:"", viernes:false},
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
const myPlayer = () => { const e=email(); return e ? S.jug.find(p=>String(p.email||"").toLowerCase()===e) : null; };
const isNew = m => (m.creado||0) > S.lastSeen && m.autor !== (S.user&&S.user.uid);
function totals(list){ let t=0,p=0; list.forEach(m=>{ t+=+m.importe||0; if(!m.pagada) p+=+m.importe||0; }); return {t, p, c:t-p}; }

/* ---------- navegación ---------- */
const VIEWS=["resumen","anadir","historial","equipo","ajustes"];
function route(){
  document.querySelector("nav.tabs").hidden = !teamOpen; $(".pot").hidden = !teamOpen;
  if(!teamOpen){ document.querySelectorAll(".view").forEach(el=>{ el.hidden = el.id !== "v-inicio"; }); window.scrollTo(0,0); return; }
  const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "resumen";
  document.querySelectorAll(".view").forEach(el=>{ el.hidden = el.id !== "v-"+v; });
  document.querySelectorAll("nav.tabs a").forEach(a=>{ a.dataset.v===v ? a.setAttribute("aria-current","page") : a.removeAttribute("aria-current"); });
  if(v==="historial"){ renderHist(); markSeenSoon(); }
  window.scrollTo(0,0);
}
let seenT;
function markSeenSoon(){ clearTimeout(seenT); seenT=setTimeout(()=>{ S.lastSeen=Date.now(); store.set("multas.lastSeen."+TEAM,S.lastSeen); renderBadge(); },2500); }

/* ---------- pintar ---------- */
function renderAll(){ renderHeader(); renderResumen(); renderAdd(); renderHist(); renderEquipo(); renderAjustes(); renderBadge(); }

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
  renderMe();
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
        <span class="av ${r.p.rol==="entrenador"?"coach":""}">${esc(initial(r.p.nombre))}</span>
        <span class="who"><b>${esc(r.p.nombre)}${isMe?' <span class="pill newp">tú</span>':""}</b><span>${r.n} ${r.n===1?"multa":"multas"}${r.p.rol==="entrenador"?" · entrenador":""}</span><span class="bar"><i style="width:${(r.t/max*100).toFixed(1)}%"></i></span></span>
        <span class="amt"><b>${eur(r.t)}</b>${r.t>0?(r.pend>0?`<span>debe ${eur(r.pend)}</span>`:`<span class="paid">pagado</span>`):""}</span>
      </button>
      ${open?`<div class="rbody">${items.length?items.map(m=>`<div class="row" style="justify-content:space-between"><span class="note">${esc(dayName(m.fecha))} · ${esc(m.tipoNombre)}${esc(qtyTxt(m))}</span><span><span class="pill ${m.pagada?"paid":"pend"}">${m.pagada?"cobrada":"pendiente"}</span> <b>${eur(m.importe)}</b></span></div>`).join(""):'<span class="note">Sin multas en este periodo.</span>'}
        ${r.pend>0&&S.canWrite?`<div class="row end"><button type="button" class="btn ok small" data-payall="${esc(r.p.id)}">Cobrar todo (${eur(r.pend)})</button></div>`:""}</div>`:""}
    </li>`;
  }).join("");
}

function renderMe(){
  const el=$("#meCard"); const e=email();
  if(!e || !S.ready.j || !S.jug.length){ el.hidden=true; return; }
  el.hidden=false;
  const me=myPlayer();
  if(me){
    const mine=S.multas.filter(m=>m.jugador===me.id && inPeriod(m)); const T=totals(mine);
    el.innerHTML=`<div class="who-line"><span class="row" style="gap:10px;flex-wrap:nowrap"><span class="av ${me.rol==="entrenador"?"coach":""}">${esc(initial(me.nombre))}</span><span><h3>Tus multas</h3><b>${esc(me.nombre)}</b></span></span>
      <span class="amt"><b>${eur(T.p)}</b><span${T.p?"":' class="paid"'}>${T.p?"por pagar":"todo pagado"}</span></span></div>
      <p class="note">${mine.length} ${mine.length===1?"apunte":"apuntes"} · ${eur(T.t)} en total${S.aj.inicio?" desde "+esc(monthName(S.aj.inicio)):""}</p>
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
      <span class="av ${p.rol==="entrenador"?"coach":""}">${esc(initial(p.nombre))}</span>
      <span class="who" data-namebox="${esc(p.id)}"><b>${esc(p.nombre)}</b><span>${p.rol==="entrenador"?"Entrenador/a":"Jugador/a"} · ${cnt(p.id)} apuntes${S.canWrite?(p.email?" · "+esc(p.email):" · sin cuenta"):(p.email?" · con cuenta":"")}</span></span>
      ${S.canWrite?`<span class="row">
        <button type="button" class="btn small ghost" data-rename="${esc(p.id)}">Renombrar</button>
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
  // cuenta
  const e=email();
  $("#loginForm").hidden = !!e;
  $("#accountOut").hidden = !e;
  $("#accountOut").innerHTML = e ? `<span><b>${esc(e)}</b><br><span class="note">${myPlayer()?"Eres "+esc(myPlayer().nombre)+" · ":"Sin vincular a ningún jugador · "}${S.canWrite?"Administrador: puedes apuntar y cobrar multas":"Puedes ver las multas"}</span></span><span class="row">${myPlayer()?'<button type="button" class="btn small ghost" id="unclaim">Desvincular</button>':""}<button type="button" class="btn small ghost" id="lOut">Salir</button></span>` : "";
  // administradores
  $("#adminCard").hidden = !S.canWrite;
  $("#adminList").innerHTML = (S.aj.admins||[]).map(a=>`<div class="adm"><span>${esc(a)}</span>${String(a).toLowerCase()!==e?`<button type="button" class="btn small danger" data-admdel="${esc(a)}">Quitar</button>`:'<span class="note">tú</span>'}</div>`).join("");
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
  M.onMessage(messaging, p=>{ if(p?.data?.tipo==="viernes") toast(p.notification?.body||"Hoy toca tiro de medio campo"); });
}
function tokenData(){ return { equipo: TEAM, uid:S.user?.uid||"", jugador: myPlayer()?.id||"", solo_mias: !!(S.prefs.mine && myPlayer()), viernes: !!S.prefs.fri, creado: Date.now(), ios: isIOS }; }
async function syncTokenPrefs(){
  const tok=store.get("multas.pushToken","");
  if(!teamOpen) return;
  if(tok) try{ await F.setDoc(dref("tokens",tok), tokenData()); }catch{}
}

/* ---------- eventos ---------- */
document.addEventListener("click", e=>{
  const t=e.target.closest("button"); if(!t) return;
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
  if(d.pay){ const m=S.multas.find(x=>x.id===d.pay); if(m) run(()=>F.updateDoc(dref("multas",m.id),{pagada:!m.pagada, pagadaEn:!m.pagada?Date.now():null}), m.pagada?"Cobro deshecho":"Marcada como cobrada"); return; }
  if(d.del){ armed(t,"¿Quitar? Toca otra vez",()=>run(()=>F.deleteDoc(dref("multas",d.del)),"Multa quitada")); return; }
  if(d.payall){ armed(t,"Confirmar cobro",()=>{ const list=S.multas.filter(m=>m.jugador===d.payall&&!m.pagada&&inPeriod(m));
      const b=F.writeBatch(db); list.forEach(m=>b.update(dref("multas",m.id),{pagada:true,pagadaEn:Date.now()}));
      run(()=>b.commit(),"Cobradas "+list.length+" multas"); }); return; }
  if(d.remove){ armed(t,"¿Quitar? Toca otra vez",()=>run(()=>F.updateDoc(dref("jugadores",d.remove),{activo:false}),"Quitado del equipo")); return; }
  if(d.restore){ run(()=>F.updateDoc(dref("jugadores",d.restore),{activo:true}),"De vuelta en el equipo"); return; }
  if(d.purge){ armed(t,"¿Eliminar? Toca otra vez",()=>run(()=>F.deleteDoc(dref("jugadores",d.purge)),"Persona eliminada")); return; }
  if(d.rename){ const box=document.querySelector(`[data-namebox="${CSS.escape(d.rename)}"]`); const p=playerById(d.rename); if(!box||!p) return;
      box.innerHTML=`<div class="row"><input type="text" id="rn-${esc(p.id)}" value="${esc(p.nombre)}" maxlength="40" aria-label="Nuevo nombre" style="flex:1;min-width:120px"><button type="button" class="btn small" data-rnsave="${esc(p.id)}">Guardar</button></div>`;
      box.querySelector("input").focus(); return; }
  if(d.rnsave){ const v=document.getElementById("rn-"+d.rnsave).value.trim(); if(!v){ toast("Escribe un nombre"); return; }
      run(()=>F.updateDoc(dref("jugadores",d.rnsave),{nombre:v.toUpperCase()}),"Nombre cambiado"); return; }
  if(d.tsave){ const id=d.tsave; const nombre=document.getElementById("tn-"+id).value.trim(); const precio=+document.getElementById("tp-"+id).value; const unidad=document.getElementById("tu-"+id).value;
      if(!nombre||!(precio>=0)){ toast("Pon un nombre y un precio válido"); return; }
      run(()=>F.updateDoc(dref("tipos",id),{nombre,precio,unidad}),"Tipo de multa guardado"); return; }
  if(d.tdel){ armed(t,"¿Borrar? Toca otra vez",()=>run(()=>F.deleteDoc(dref("tipos",d.tdel)),"Tipo de multa borrado")); return; }
  if(d.admdel){ armed(t,"¿Quitar? Toca otra vez",()=>run(()=>F.updateDoc(dref("ajustes","general"),{admins:F.arrayRemove(d.admdel)}),"Administrador quitado")); return; }
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
$("#tcFri").addEventListener("change",e=>run(()=>F.updateDoc(teamRef(),{viernes:e.target.checked}),e.target.checked?"Recordatorio activado para todo el equipo":"Recordatorio desactivado"));
$("#tcFile").addEventListener("change",e=>{ const f=e.target.files?.[0]; if(f) setCrest(f); e.target.value=""; });
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
    b.set(F.doc(col("multas")),{jugador:id, jugadorNombre:p?.nombre||"", tipo:t.id, tipoNombre:t.nombre, unidad:t.unidad||"fijo", precio:+t.precio, cantidad:q, importe:(+t.precio)*q, fecha, nota, pagada:false, notificada:false, creado:Date.now(), autor:S.user?.uid||""}); });
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
  unsubs.push(F.onSnapshot(col("tipos"), s=>{ S.tipos=s.docs.map(d=>({id:d.id,...d.data()})); S.ready.t=true; done(s); renderAll(); }, fail));
  unsubs.push(F.onSnapshot(teamRef(), s=>{
    if(!s.exists()){
      if(s.metadata.fromCache) return;
      toast("No existe ningún equipo con el código "+TEAM); leaveTeam(); return;
    }
    S.aj=Object.assign({nombre:"",inicio:"",contador:"",admins:[],escudo:"",viernes:false}, s.data());
    rememberTeam(TEAM, S.aj.nombre);
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
  Object.assign(S,{jug:[],tipos:[],multas:[],aj:{nombre:"",inicio:"",contador:"",admins:[],escudo:"",viernes:false},ready:{j:false,t:false,m:false,a:false},canWrite:false,selType:null,openRank:null,meId:undefined});
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
    b.set(F.doc(db,"equipos",id),{nombre, admins:[email()], contador:$("#ctCount").value.trim(), inicio:"", viernes:false, escudo:"", creado:Date.now(), creador:S.user.uid});
    if($("#ctSample").checked) DEFAULT_TYPES.forEach(([n,precio,unidad],i)=>b.set(F.doc(db,"equipos",id,"tipos","t"+(i+1)),{nombre:n,precio,unidad,orden:i+1}));
    if(await run(()=>b.commit(),"Equipo creado: "+nombre)){ rememberTeam(id,nombre); location.hash="equipo"; openTeam(id); }
  } finally { btn.disabled=false; }
}
async function migrateLegacy(){
  const btn=$("#migrateBtn"); btn.disabled=true; btn.textContent="Pasando los datos…";
  try{
    const L=(await F.getDoc(F.doc(db,"ajustes","general"))).data()||{};
    let escudo=""; try{ const blob=await (await fetch("icons/escudo-128.png")).blob(); escudo=await new Promise(r=>{ const fr=new FileReader(); fr.onload=()=>r(fr.result); fr.readAsDataURL(blob); }); }catch{}
    const ok=await run(()=>F.setDoc(F.doc(db,"equipos",LEGACY_TEAM),{nombre:"Caixa Ontinyent", admins:L.admins||[email()], contador:L.contador||"", inicio:L.inicio||"", viernes:true, escudo, creado:Date.now(), creador:S.user.uid}));
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
  renderAll(); renderLanding();
});

if("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(e=>console.warn("SW",e));
$("#fecha").value=today();
route(); renderInstall(); renderAll(); renderLanding();
if(store.get("multas.pushToken","")) listenForeground();
