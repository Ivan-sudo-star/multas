// Multas Caixa Ontinyent — app web instalable (Firebase, plan gratuito)
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
const UNIT_TXT = {fijo:"", minuto:"/min", cabeza:" por cabeza"};
const qtyTxt = m => m.unidad==="minuto" ? " · "+m.cantidad+" min" : (m.cantidad>1 ? " ×"+m.cantidad : "");

const SEED_PLAYERS = [
  ["XAVIER NOGUERA","jugador"],["VICTOR FERNANDEZ","jugador"],["S. T.","jugador"],["JOSEP SORIANO","jugador"],
  ["JAIME MAS","jugador"],["IVAN CAMBRA","jugador"],["VICTOR CAMBRA","jugador"],["HUGO ABAD","jugador"],
  ["BLAI REIG","jugador"],["IKER GARCIA","jugador"],["IÑAKI VILLAR","jugador"],["JOSE IGNACIO BLASCO","entrenador"]];
const SEED_TYPES = [
  ["Tarde al entreno (+5 min)",3,"fijo"],["Falta al entreno sin avisar",5,"fijo"],["Tarde al partido sin avisar",1,"minuto"],
  ["Técnica / Flagrante",5,"fijo"],["Expulsión",3,"fijo"],["Técnica banquillo",2,"cabeza"],["Técnica entrenador",5,"fijo"],
  ["Tiro medio campo (viernes, el último)",2,"fijo"]];

const S = {
  jug: [], tipos: [], multas: [], aj: {inicio:"", contador:"", admins:[]}, ajExists: null,
  ready: {j:false,t:false,m:false,a:false},
  user: null, canWrite: false,
  selType: null, selPlayers: new Set(), openRank: null,
  lastSeen: store.get("multas.lastSeen", 0),
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
  if(c.includes("permission-denied")) return "No tienes permiso. Entra como administrador en Ajustes.";
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
const dref = (c,id) => F.doc(db,c,id);

/* ---------- datos derivados ---------- */
const fromDate = () => S.aj.inicio ? S.aj.inicio+"-01" : "";
const inPeriod = m => !fromDate() || (m.fecha||"") >= fromDate();
const playerById = id => S.jug.find(p=>p.id===id);
const typeById = id => S.tipos.find(t=>t.id===id);
function sortPlayers(a,b){ if((a.rol==="entrenador")!==(b.rol==="entrenador")) return a.rol==="entrenador"?1:-1; return (a.nombre||"").localeCompare(b.nombre||"","es"); }
const activePlayers = () => S.jug.filter(p=>p.activo!==false).sort(sortPlayers);
const initial = n => (n||"?").trim().charAt(0).toUpperCase();
const isNew = m => (m.creado||0) > S.lastSeen && m.autor !== (S.user&&S.user.uid);
function totals(list){ let t=0,p=0; list.forEach(m=>{ t+=+m.importe||0; if(!m.pagada) p+=+m.importe||0; }); return {t, p, c:t-p}; }

/* ---------- navegación ---------- */
const VIEWS=["resumen","anadir","historial","equipo","ajustes"];
function route(){
  const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "resumen";
  document.querySelectorAll(".view").forEach(el=>{ el.hidden = el.id !== "v-"+v; });
  document.querySelectorAll("nav.tabs a").forEach(a=>{ a.dataset.v===v ? a.setAttribute("aria-current","page") : a.removeAttribute("aria-current"); });
  if(v==="historial"){ renderHist(); markSeenSoon(); }
  window.scrollTo(0,0);
}
let seenT;
function markSeenSoon(){ clearTimeout(seenT); seenT=setTimeout(()=>{ S.lastSeen=Date.now(); store.set("multas.lastSeen",S.lastSeen); renderBadge(); },2500); }

/* ---------- pintar ---------- */
function renderAll(){ renderHeader(); renderResumen(); renderAdd(); renderHist(); renderEquipo(); renderAjustes(); renderBadge(); }

function renderHeader(){
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
  $("#fridayBanner").hidden = !(new Date().getDay()===5 && S.prefs.fri);
  $("#setupCard").hidden = !(S.ajExists===false && email());

  const by = new Map();
  S.jug.forEach(p=>by.set(p.id,{p, t:0, pend:0, n:0, items:[]}));
  list.forEach(m=>{ let r=by.get(m.jugador); if(!r){ r={p:{id:m.jugador,nombre:m.jugadorNombre||"Sin nombre",activo:false}, t:0,pend:0,n:0,items:[]}; by.set(m.jugador,r); }
    r.t+=+m.importe||0; if(!m.pagada) r.pend+=+m.importe||0; r.n+=(m.unidad==="minuto"?1:(m.cantidad||1)); r.items.push(m); });
  const rows=[...by.values()].filter(r=>r.p.activo!==false || r.n>0).sort((a,b)=>b.t-a.t || sortPlayers(a.p,b.p));
  const max = Math.max(1,...rows.map(r=>r.t));
  const el=$("#rank");
  if(!loaded){ el.innerHTML='<li class="empty">Cargando…</li>'; return; }
  if(!rows.length){ el.innerHTML='<li class="empty"><b>Aún no hay nadie</b>'+(S.ajExists===false?"Entra como administrador en Ajustes y pulsa «Configurar el equipo».":"Ve a «Equipo» y añade a los jugadores.")+'</li>'; return; }
  el.innerHTML = rows.map((r,i)=>{
    const open = S.openRank===r.p.id;
    const items = r.items.sort((a,b)=>(b.fecha||"").localeCompare(a.fecha||"")||(b.creado||0)-(a.creado||0));
    return `<li class="rrow">
      <button type="button" class="rhead" data-rank="${esc(r.p.id)}" aria-expanded="${open}">
        <span class="pos">${r.t>0?i+1:"–"}</span>
        <span class="av ${r.p.rol==="entrenador"?"coach":""}">${esc(initial(r.p.nombre))}</span>
        <span class="who"><b>${esc(r.p.nombre)}</b><span>${r.n} ${r.n===1?"multa":"multas"}${r.p.rol==="entrenador"?" · entrenador":""}</span><span class="bar"><i style="width:${(r.t/max*100).toFixed(1)}%"></i></span></span>
        <span class="amt"><b>${eur(r.t)}</b>${r.t>0?(r.pend>0?`<span>debe ${eur(r.pend)}</span>`:`<span class="paid">pagado</span>`):""}</span>
      </button>
      ${open?`<div class="rbody">${items.length?items.map(m=>`<div class="row" style="justify-content:space-between"><span class="note">${esc(dayName(m.fecha))} · ${esc(m.tipoNombre)}${esc(qtyTxt(m))}</span><span><span class="pill ${m.pagada?"paid":"pend"}">${m.pagada?"cobrada":"pendiente"}</span> <b>${eur(m.importe)}</b></span></div>`).join(""):'<span class="note">Sin multas en este periodo.</span>'}
        ${r.pend>0&&S.canWrite?`<div class="row end"><button type="button" class="btn ok small" data-payall="${esc(r.p.id)}">Cobrar todo (${eur(r.pend)})</button></div>`:""}</div>`:""}
    </li>`;
  }).join("");
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
      <span class="who" data-namebox="${esc(p.id)}"><b>${esc(p.nombre)}</b><span>${p.rol==="entrenador"?"Entrenador/a":"Jugador/a"} · ${cnt(p.id)} apuntes</span></span>
      ${S.canWrite?`<span class="row">
        <button type="button" class="btn small ghost" data-rename="${esc(p.id)}">Renombrar</button>
        ${active?`<button type="button" class="btn small danger" data-remove="${esc(p.id)}">Quitar</button>`
          :`<button type="button" class="btn small ghost" data-restore="${esc(p.id)}">Recuperar</button>${cnt(p.id)?"":`<button type="button" class="btn small danger" data-purge="${esc(p.id)}">Eliminar</button>`}`}
      </span>`:""}
    </div>`;
  $("#activeList").innerHTML = act.length?act.map(p=>row(p,true)).join(""):'<p class="note">'+(S.ready.j?"Todavía no hay nadie en el equipo.":"Cargando…")+'</p>';
  $("#inactiveCard").hidden=!ina.length;
  $("#inactiveList").innerHTML=ina.map(p=>row(p,false)).join("");
}

let ajFilled=false;
function renderAjustes(){
  // cuenta
  const e=email();
  $("#loginForm").hidden = !!e;
  $("#accountOut").hidden = !e;
  $("#accountOut").innerHTML = e ? `<span><b>${esc(e)}</b><br><span class="note">${S.canWrite?"Administrador: puedes apuntar y cobrar multas":"Sin permiso para apuntar. Pide a un administrador que añada este correo."}</span></span><button type="button" class="btn small ghost" id="lOut">Salir</button>` : "";
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
  $("#nLive").checked=S.prefs.live; $("#nFri").checked=S.prefs.fri;
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
    await F.setDoc(dref("tokens", token), { uid: S.user?.uid||"", viernes: !!S.prefs.fri, creado: Date.now(), ios: isIOS });
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
async function syncTokenPrefs(){
  const tok=store.get("multas.pushToken","");
  if(tok) try{ await F.setDoc(dref("tokens",tok), { uid:S.user?.uid||"", viernes: !!S.prefs.fri, creado: Date.now(), ios: isIOS }); }catch{}
}

/* ---------- eventos ---------- */
document.addEventListener("click", e=>{
  const t=e.target.closest("button"); if(!t) return;
  const d=t.dataset;
  if(t.id==="hideInstall"){ store.set("multas.hideInstall",true); renderInstall(); return; }
  if(t.id==="doInstall"&&installEvt){ installEvt.prompt(); installEvt.userChoice.finally(()=>{ installEvt=null; renderInstall(); }); return; }
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
$("#nFri").addEventListener("change",e=>{ S.prefs.fri=e.target.checked; store.set("multas.prefs",S.prefs); renderResumen(); syncTokenPrefs(); });
$("#fridayBtn").addEventListener("click",()=>{ const t=S.tipos.find(x=>/medio campo/i.test(x.nombre)); if(t) S.selType=t.id; S.selPlayers.clear(); location.hash="anadir"; renderAdd(); });
$("#pushBtn").addEventListener("click",()=>{ $("#pushBtn").dataset.on ? disablePush() : enablePush(); });

$("#addForm").addEventListener("submit", e=>{
  e.preventDefault();
  const t=typeById(S.selType); const ids=[...S.selPlayers]; if(!t||!ids.length) return;
  const q=getQty(); const fecha=$("#fecha").value||today(); const nota=$("#nota").value.trim();
  const b=F.writeBatch(db);
  ids.forEach(id=>{ const p=playerById(id);
    b.set(F.doc(F.collection(db,"multas")),{jugador:id, jugadorNombre:p?.nombre||"", tipo:t.id, tipoNombre:t.nombre, unidad:t.unidad||"fijo", precio:+t.precio, cantidad:q, importe:(+t.precio)*q, fecha, nota, pagada:false, notificada:false, creado:Date.now(), autor:S.user?.uid||""}); });
  // El lote se guarda en el móvil al momento y se sube cuando hay red
  b.commit().catch(err=>{ console.error(err); toast(errMsg(err)); });
  toast(ids.length===1?"Multa puesta: "+eur((+t.precio)*q):ids.length+" multas puestas");
  S.selPlayers.clear(); $("#nota").value=""; $("#qty").value=1; renderAdd();
});

$("#playerForm").addEventListener("submit", async e=>{
  e.preventDefault();
  const nombre=$("#pName").value.trim().toUpperCase(); if(!nombre){ toast("Escribe el nombre"); return; }
  if(S.jug.some(p=>p.nombre===nombre && p.activo!==false)){ toast(nombre+" ya está en el equipo"); return; }
  const ok=await run(()=>F.addDoc(F.collection(db,"jugadores"),{nombre, rol:$("#pRole").value, activo:true, creado:Date.now()}), nombre+" añadido");
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
  run(()=>F.addDoc(F.collection(db,"tipos"),{nombre,precio,unidad:$("#tUnit").value,orden}),"Tipo de multa añadido").then(ok=>{ if(ok) $("#tName").value=""; });
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
$("#setupBtn").addEventListener("click", async ()=>{
  const btn=$("#setupBtn"); btn.disabled=true;
  const ok = await run(()=>F.setDoc(dref("ajustes","general"),{inicio:"", contador:"Ivan", admins:[email()]}));
  if(!ok){ btn.disabled=false; return; }
  const b=F.writeBatch(db);
  SEED_PLAYERS.forEach(([nombre,rol],i)=>b.set(dref("jugadores","p"+pad(i+1)),{nombre,rol,activo:true,creado:Date.now()}));
  SEED_TYPES.forEach(([nombre,precio,unidad],i)=>b.set(dref("tipos","t"+(i+1)),{nombre,precio,unidad,orden:i+1}));
  await run(()=>b.commit(),"Equipo configurado");
  btn.disabled=false;
});
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
  unsubs.push(F.onSnapshot(F.collection(db,"jugadores"), s=>{ S.jug=s.docs.map(d=>({id:d.id,...d.data()})); S.ready.j=true; done(s); renderAll(); }, fail));
  unsubs.push(F.onSnapshot(F.collection(db,"tipos"), s=>{ S.tipos=s.docs.map(d=>({id:d.id,...d.data()})); S.ready.t=true; done(s); renderAll(); }, fail));
  unsubs.push(F.onSnapshot(dref("ajustes","general"), s=>{
    S.ajExists = s.exists() ? true : (s.metadata.fromCache ? S.ajExists : false);
    S.aj=Object.assign({inicio:"",contador:"",admins:[]}, s.exists()?s.data():{});
    if(!s.metadata.hasPendingWrites) ajFilled=false;
    computeWrite(); S.ready.a=true; done(s); renderAll(); }, fail));
  unsubs.push(F.onSnapshot(F.collection(db,"multas"), s=>{
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

let lastUid=null;
A.onAuthStateChanged(auth, u=>{
  if(!u){ A.signInAnonymously(auth).catch(e=>setStatus("No se puede conectar: "+errMsg(e)+". Revisa que el acceso anónimo esté activado (GUIA.md).")); return; }
  S.user=u; computeWrite();
  if(u.uid!==lastUid){ lastUid=u.uid; subscribe(); syncTokenPrefs(); }
  renderAll();
});

if("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(e=>console.warn("SW",e));
$("#fecha").value=today();
route(); renderInstall(); renderAll();
if(store.get("multas.pushToken","")) listenForeground();
