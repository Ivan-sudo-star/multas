"""Envía las notificaciones push de la app de multas.

Lo ejecuta GitHub Actions gratis (ver .github/workflows/avisos.yml):
  python scripts/avisos.py multas    -> avisa de las multas nuevas y de entrenos/partidos
                                        (nuevos, «avisar ahora» y recordatorio del mismo día)
  python scripts/avisos.py viernes   -> recordatorio del tiro de medio campo
Necesita la variable FIREBASE_SERVICE_ACCOUNT (el JSON de la cuenta de servicio)
y, opcionalmente, APP_URL (la dirección de la app, terminada en /).
"""
import json
import math
import os
import sys
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

if not os.environ.get("FIREBASE_SERVICE_ACCOUNT", "").strip():
    print("Notificaciones sin configurar (falta el secreto FIREBASE_SERVICE_ACCOUNT). No se envía nada.")
    sys.exit(0)

import firebase_admin
from firebase_admin import credentials, firestore, messaging

def fail(msg):
    # "::error::" hace que GitHub muestre el mensaje en el resumen de la ejecución
    print("::error::" + msg)
    sys.exit(1)


try:
    info = json.loads(os.environ["FIREBASE_SERVICE_ACCOUNT"])
except Exception as e:
    fail(f"El secreto FIREBASE_SERVICE_ACCOUNT no es un JSON válido ({e}). Vuelve a pegar TODO el contenido del archivo .json, desde la primera {{ hasta la última }}.")
if info.get("type") != "service_account" or "private_key" not in info:
    fail("El secreto FIREBASE_SERVICE_ACCOUNT no parece la clave de una cuenta de servicio (falta type/private_key).")
try:
    firebase_admin.initialize_app(credentials.Certificate(info))
except Exception as e:
    fail(f"No se pudo usar la clave de la cuenta de servicio: {e}")
db = firestore.client()
APP_URL = os.environ.get("APP_URL", "").strip()
if APP_URL and not APP_URL.endswith("/"):
    APP_URL += "/"


def eur(n):
    n = round(float(n or 0), 2)
    return (str(int(n)) if n == int(n) else f"{n:.2f}".replace(".", ",")) + " €"


def webpush_cfg(view):
    if not APP_URL.startswith("https://"):
        return None
    return messaging.WebpushConfig(
        headers={"Urgency": "high"},
        notification=messaging.WebpushNotification(
            icon=APP_URL + "icons/icon-192.png",
            badge=APP_URL + "icons/badge-96.png",   # icono pequeño de la barra de estado (Android)
            vibrate=[200, 100, 200],
            renotify=True,
            tag=view,
        ),
        fcm_options=messaging.WebpushFCMOptions(link=APP_URL + "#" + view),
    )


def send(tokens, title, body, data=None, view="historial"):
    """Envía a todos los móviles y borra los que ya no existen."""
    sent, dead = 0, []
    for i in range(0, len(tokens), 500):
        chunk = tokens[i:i + 500]
        webpush = webpush_cfg(view)
        msg = messaging.MulticastMessage(
            tokens=chunk,
            notification=messaging.Notification(title=title, body=body),
            data=data or {},
            webpush=webpush,
        )
        res = messaging.send_each_for_multicast(msg)
        sent += res.success_count
        for tok, r in zip(chunk, res.responses):
            if not r.success and isinstance(r.exception, (messaging.UnregisteredError, messaging.SenderIdMismatchError)):
                dead.append(tok)
    for tok in dead:
        db.collection("tokens").document(tok).delete()
    print(f"::notice::Notificaciones enviadas: {sent}. Móviles dados de baja: {len(dead)}")


def all_tokens():
    return [(d.id, d.to_dict() or {}) for d in db.collection("tokens").stream()]


def describe(m):
    extra = f" ({m.get('cantidad')} min)" if m.get("unidad") == "minuto" else (f" ×{m.get('cantidad')}" if (m.get("cantidad") or 1) > 1 else "")
    return f"{m.get('tipoNombre', '')}{extra} · {eur(m.get('importe'))}"


LEGACY_TEAM = "ONTINYENT"  # móviles registrados antes de haber varios equipos


def tokens_by_team():
    by = {}
    for tok, info in all_tokens():
        by.setdefault(info.get("equipo") or LEGACY_TEAM, []).append((tok, info))
    return by


def avisar_multas():
    toks_team = None
    total = 0
    for team in db.collection("equipos").stream():
        def toks(team_id=team.id):
            nonlocal toks_team
            if toks_team is None:
                toks_team = tokens_by_team()
            return toks_team.get(team_id, [])
        total += avisar_eventos(team, toks)
        total += avisar_tablon(team, toks)
        total += avisar_viernes_equipo(team, toks)
        total += avisar_planes(team, toks)
        total += pagos_equipo(team, toks)
        nuevas = list(team.reference.collection("multas")
                      .where(filter=firestore.FieldFilter("notificada", "==", False)).stream())
        if not nuevas:
            continue
        total += len(nuevas)
        nombre = (team.to_dict() or {}).get("nombre", "")
        avisar_equipo(nombre, [d.to_dict() for d in nuevas], toks())
        batch = db.batch()
        for d in nuevas:
            batch.update(d.reference, {"notificada": True})
        batch.commit()
    if not total:
        print("::notice::Nada que avisar")


def avisar_equipo(nombre, multas, tokens):
    mensajes = []
    for tok, info in tokens:
        uid, jug = info.get("uid", ""), info.get("jugador", "")
        mias = [m for m in multas if jug and m.get("jugador") == jug]
        if info.get("solo_mias") and not mias:
            continue
        if mias:
            title = "💸 Te han puesto una multa" if len(mias) == 1 else f"💸 Te han puesto {len(mias)} multas"
            body = " / ".join(describe(m) for m in mias)
            otras = len(multas) - len(mias)
            if otras:
                body += f" (+{otras} al resto)"
        elif len(multas) == 1:
            m = multas[0]
            title, body = "💸 Nueva multa", f"{m.get('jugadorNombre', '')} · {describe(m)}"
        else:
            por = {}
            for m in multas:
                n = m.get("jugadorNombre", "?")
                por[n] = por.get(n, 0) + float(m.get("importe") or 0)
            title = f"💸 {len(multas)} multas nuevas"
            body = ", ".join(f"{n} {eur(v)}" for n, v in sorted(por.items(), key=lambda x: -x[1]))
        if nombre:
            title += f" · {nombre}"
        mensajes.append((tok, title, body[:200]))
    send_each(mensajes)


def send_each(mensajes, data=None, view="historial"):
    """Un mensaje distinto para cada móvil."""
    if not mensajes:
        print("::notice::Nadie a quien avisar (ningún móvil con notificaciones activadas en este equipo)")
        return
    sent, dead = 0, []
    for i in range(0, len(mensajes), 500):
        chunk = mensajes[i:i + 500]
        msgs = [messaging.Message(token=tok, notification=messaging.Notification(title=t, body=b),
                                  data=data or {"tipo": "multa"}, webpush=webpush_cfg(view)) for tok, t, b in chunk]
        res = messaging.send_each(msgs)
        sent += res.success_count
        for (tok, _, _), r in zip(chunk, res.responses):
            if not r.success and isinstance(r.exception, (messaging.UnregisteredError, messaging.SenderIdMismatchError)):
                dead.append(tok)
    for tok in dead:
        db.collection("tokens").document(tok).delete()
    print(f"::notice::Notificaciones enviadas: {sent}. Móviles dados de baja: {len(dead)}")


def avisar_tablon(team, toks):
    """Avisos que escriben los administradores en el tablón: a todo el equipo."""
    nuevos = list(team.reference.collection("avisos")
                  .where(filter=firestore.FieldFilter("notificada", "==", False)).stream())
    if not nuevos:
        return 0
    nombre = (team.to_dict() or {}).get("nombre", "")
    tokens = toks()
    for d in nuevos:
        a = d.to_dict() or {}
        title = f"📣 {a.get('autorNombre') or 'Aviso'}" + (f" · {nombre}" if nombre else "")
        mensajes = [(tok, title, str(a.get("texto", ""))[:200]) for tok, info in tokens if info.get("uid") != a.get("autor")]
        send_each(mensajes, data={"tipo": "aviso"}, view="resumen")
        d.reference.update({"notificada": True})
    return len(nuevos)


TZ = ZoneInfo("Europe/Madrid")
DIAS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
TIPO = {"entreno": "entreno", "partido": "partido"}
RECORDAR_ANTES = 8  # horas, si el equipo no ha configurado otra cosa
MANANA_HASTA = 14   # los que empiezan antes de esta hora se avisan la tarde anterior
AVISO_VISPERA = time(17, 0)  # hora del aviso del día anterior


def plazo_cfg(team_data):
    p = team_data.get("plazo") or {}
    return {"activo": bool(p.get("activo")), "aviso": float(p.get("aviso") or RECORDAR_ANTES),
            "cierre": float(p.get("cierre") if p.get("cierre") is not None else 3), "tipo": p.get("tipo") or ""}


def inicio(ev):
    if not ev.get("hora"):
        return None
    h, m = (int(x) for x in ev["hora"].split(":")[:2])
    return datetime.combine(date.fromisoformat(ev["fecha"]), time(h, m), TZ)


def momento_recordatorio(start, horas, cierre=None):
    """Nunca de madrugada y siempre al menos 1 h antes del cierre del plazo (o del inicio):
    si toca entre las 23:00 y las 8:00, se pasa a las 8:00 o, si no da tiempo, a las 17:00 del día antes."""
    # Entrenos de mañana (antes de las 14:00): se avisa la tarde anterior a las 17:00
    if start.hour < MANANA_HASTA:
        return datetime.combine(start.date() - timedelta(days=1), AVISO_VISPERA, TZ)
    limite = (cierre or start) - timedelta(hours=1)
    rem = min(start - timedelta(hours=horas), limite)
    if rem.hour >= 23:
        return datetime.combine(rem.date(), AVISO_VISPERA, TZ)
    if rem.hour < 8:
        a_las_8 = rem.replace(hour=8, minute=0)
        if a_las_8 <= limite:
            return a_las_8
        return datetime.combine(rem.date() - timedelta(days=1), AVISO_VISPERA, TZ)
    return rem


def hora_txt(dt, hoy):
    d = dt.date()
    dia = "hoy" if d == hoy else "mañana" if d == hoy + timedelta(days=1) else f"el {DIAS[d.weekday()]} {d.day}"
    return f"{dia} a las {dt:%H:%M}"


def texto_plazo(c, cierre, tipo_multa, ahora):
    """Texto del recordatorio según lo que haya contestado cada uno."""
    multa = f" Si no contestas, multa de {eur(tipo_multa.get('precio'))}." if tipo_multa else ""
    if cierre and ahora < cierre:
        plazo = hora_txt(cierre, ahora.date())
        if c == "si":
            return f"Has dicho que vas ✅. Si cambias de idea, avísalo en la app. El plazo se cierra {plazo}."
        return f"⚠️ Avisa en la app si vas o no. El plazo se cierra {plazo}.{multa}"
    if c == "si":
        return "Has dicho que vas ✅. Te esperamos."
    return "¿Vas? Contesta en la app para que el entrenador sepa cuántos seréis."


def cierre_de(ev, pl):
    if ev.get("cierre"):
        return datetime.fromtimestamp(ev["cierre"] / 1000, TZ)
    return None


def cuando(ev, hoy):
    d = date.fromisoformat(ev["fecha"])
    txt = "hoy" if d == hoy else "mañana" if d == hoy + timedelta(days=1) else f"el {DIAS[d.weekday()]} {d.day}"
    return txt + (f" a las {ev['hora']}" if ev.get("hora") else "")


def avisar_eventos(team, toks):
    """Entrenos y partidos: nuevos, «avisar a todos ahora» y recordatorio del mismo día."""
    ahora = datetime.now(TZ)
    hoy = ahora.date()
    ref = team.reference.collection("eventos")
    F = firestore.FieldFilter
    nuevos = {d.id: d for d in ref.where(filter=F("notificada", "==", False)).stream()}
    pedidos = {d.id: d for d in ref.where(filter=F("avisar", "==", True)).stream()}
    tdata = team.to_dict() or {}
    pl = plazo_cfg(tdata)
    recordar, cerrar, ultima = {}, {}, {}
    proximos = ref.where(filter=F("fecha", "in", [hoy.isoformat(), (hoy + timedelta(days=1)).isoformat()])).stream()
    for d in proximos:
        ev = d.to_dict() or {}
        start = inicio(ev)
        if not ev.get("recordado"):
            if start:
                if momento_recordatorio(start, pl["aviso"], cierre_de(ev, pl)) <= ahora <= start + timedelta(hours=1):
                    recordar[d.id] = d
            elif ev["fecha"] == hoy.isoformat() and ahora.hour >= 10:
                recordar[d.id] = d
        c = cierre_de(ev, pl)
        if c and not ev.get("plazoCerrado") and c <= ahora <= c + timedelta(hours=12):
            cerrar[d.id] = d
        if c and not ev.get("ultimaHora") and c - ULTIMA_HORA <= ahora < c:
            ultima[d.id] = d
    if cerrar:
        multar_sin_respuesta(team, pl, cerrar)
        resumen_entrenador(team, cerrar, toks, ahora)
    if ultima:
        avisar_ultima_hora(team, pl, ultima, toks, ahora)
    if not (nuevos or pedidos or recordar):
        return len(cerrar) + len(ultima)

    nombre = tdata.get("nombre", "")
    tipo_multa = None
    if pl["activo"] and pl["tipo"]:
        t = team.reference.collection("tipos").document(pl["tipo"]).get()
        tipo_multa = t.to_dict() if t.exists else None
    emails = {p.id: str((p.to_dict() or {}).get("email", "")).lower() for p in team.reference.collection("jugadores").stream()}
    tokens = toks()
    mensajes, cambios = [], {}
    for evid in set(nuevos) | set(pedidos) | set(recordar):
        d = nuevos.get(evid) or pedidos.get(evid) or recordar.get(evid)
        ev = d.to_dict() or {}
        tipo = TIPO.get(ev.get("tipo"), "evento")
        que = f"{tipo}{' · ' + ev['nota'] if ev.get('nota') else ''}"
        es_nuevo = evid in nuevos
        for tok, info in tokens:
            c = (ev.get("confirma") or {}).get(emails.get(info.get("jugador", ""), ""), "")
            if es_nuevo:
                if info.get("uid") == ev.get("autor"):
                    continue
                title = f"🏀 Nuevo {tipo} · {nombre}" if nombre else f"🏀 Nuevo {tipo}"
                body = f"{que.capitalize()} {cuando(ev, hoy)}."
                if (ev.get("serie") or 0) > 1:
                    body += f" Se repite cada semana ({ev['serie']} semanas)."
                body += " " + texto_plazo(c, cierre_de(ev, pl), tipo_multa, ahora)
            else:
                if c == "no":
                    continue
                title = f"⏰ {tipo.capitalize()} {cuando(ev, hoy)}"
                body = texto_plazo(c, cierre_de(ev, pl), tipo_multa, ahora)
                if ev.get("nota"):
                    body = f"{ev['nota']}. {body}"
            mensajes.append((tok, title, body[:200]))
        upd = {}
        if es_nuevo:
            upd["notificada"] = True
            if evid in recordar:
                upd["recordado"] = True
        if evid in pedidos:
            upd["avisar"] = False
            upd["avisadoEn"] = int(ahora.timestamp() * 1000)
        if evid in recordar:
            upd["recordado"] = True
        cambios[d.reference] = upd
    send_each(mensajes, data={"tipo": "evento"}, view="asistencia")
    batch = db.batch()
    for r, upd in cambios.items():
        batch.update(r, upd)
    batch.commit()
    return len(cambios)


ULTIMA_HORA = timedelta(hours=1)


def avisar_ultima_hora(team, pl, eventos, toks, ahora):
    """1 h antes del cierre: solo a los jugadores con cuenta que aún no han dicho si van."""
    jugadores = {p.id: p.to_dict() or {} for p in team.reference.collection("jugadores").stream()}
    tipo_multa = None
    if pl["activo"] and pl["tipo"]:
        t = team.reference.collection("tipos").document(pl["tipo"]).get()
        tipo_multa = t.to_dict() if t.exists else None
    tokens = toks()
    mensajes = []
    for evid, d in eventos.items():
        ev = d.to_dict() or {}
        tipo = TIPO.get(ev.get("tipo"), "evento")
        cierre = cierre_de(ev, pl)
        confirma = ev.get("confirma") or {}
        for tok, info in tokens:
            p = jugadores.get(info.get("jugador", ""))
            if not p or p.get("activo") is False or p.get("rol") == "entrenador":
                continue
            email = str(p.get("email", "")).lower()
            if not email or confirma.get(email) in ("si", "no"):
                continue
            title = f"⏳ Última hora: {tipo} {cuando(ev, ahora.date())}"
            body = f"Aún no has avisado si vas. El plazo se cierra {hora_txt(cierre, ahora.date())}."
            if tipo_multa:
                body += f" Si no contestas, multa de {eur(tipo_multa.get('precio'))}."
            mensajes.append((tok, title, body[:200]))
        d.reference.update({"ultimaHora": True})
    send_each(mensajes, data={"tipo": "evento"}, view="asistencia")


def nombre_corto(nombre):
    """«IVAN CAMBRA» → «Ivan C.»"""
    partes = str(nombre or "?").split()
    corto = partes[0].capitalize()
    return corto + (f" {partes[1][0].upper()}." if len(partes) > 1 else "")


def resumen_entrenador(team, eventos, toks, ahora):
    """Al cerrarse el plazo: quién va, quién no y quién no ha contestado, para los entrenadores y el propietario."""
    jugadores = {p.id: p.to_dict() or {} for p in team.reference.collection("jugadores").stream()}
    entrenadores = {pid for pid, p in jugadores.items() if p.get("rol") == "entrenador" and p.get("activo") is not False}
    # También al propietario del equipo
    propietario = str((team.to_dict() or {}).get("propietario", "")).lower()
    destinatarios = entrenadores | {pid for pid, p in jugadores.items()
                                    if propietario and str(p.get("email", "")).lower() == propietario}
    tokens = [(tok, info) for tok, info in toks() if info.get("jugador") in destinatarios]
    if not tokens:
        print("::notice::Resumen de asistencia: ni el entrenador ni el propietario tienen notificaciones activadas")
        return
    mensajes = []
    for evid, d in eventos.items():
        ev = d.to_dict() or {}
        confirma, notas = ev.get("confirma") or {}, ev.get("notas") or {}
        van, no, sin = [], [], []
        for pid, p in sorted(jugadores.items(), key=lambda x: str(x[1].get("nombre", ""))):
            if p.get("activo") is False or pid in entrenadores:
                continue
            email = str(p.get("email", "")).lower()
            c = confirma.get(email) if email else None
            (van if c == "si" else no if c == "no" else sin).append(nombre_corto(p.get("nombre")))
        tipo = TIPO.get(ev.get("tipo"), "evento")
        title = f"📋 {tipo.capitalize()} {cuando(ev, ahora.date())} · plazo cerrado"
        partes = [f"✅ {len(van)} van: {', '.join(van)}" if van else "✅ Nadie ha dicho que va"]
        if no:
            partes.append(f"❌ {len(no)} no: {', '.join(no)}")
        if sin:
            partes.append(f"❓ {len(sin)} sin contestar: {', '.join(sin)}")
        n_notas = sum(1 for v in notas.values() if v)
        if n_notas:
            partes.append(f"📝 {n_notas} comentario{'s' if n_notas > 1 else ''} en la app")
        body = "\n".join(partes)
        mensajes += [(tok, title, body[:400]) for tok, _ in tokens]
    send_each(mensajes, data={"tipo": "evento"}, view="asistencia")


def multar_sin_respuesta(team, pl, eventos):
    """Al cerrarse el plazo: multa a los jugadores con cuenta que no han dicho si van."""
    tipo = None
    if pl["activo"] and pl["tipo"]:
        t = team.reference.collection("tipos").document(pl["tipo"]).get()
        tipo = (t.id, t.to_dict()) if t.exists else None
    jugadores = [(p.id, p.to_dict() or {}) for p in team.reference.collection("jugadores").stream()]
    batch, n = db.batch(), 0
    for evid, d in eventos.items():
        ev = d.to_dict() or {}
        upd = {"plazoCerrado": True, "multadosPlazo": []}
        cierre = cierre_de(ev, pl)
        # Si el entreno se creó ya con el plazo casi cerrado, no se multa.
        # (El cierre lo calcula la app: entrenos de mañana → día anterior a las 23:59.)
        creado = datetime.fromtimestamp((ev.get("creado") or 0) / 1000, TZ)
        if tipo and ev.get("tipo") == "entreno" and cierre and creado < cierre - timedelta(hours=1):
            confirma = ev.get("confirma") or {}
            for pid, p in jugadores:
                email = str(p.get("email", "")).lower()
                if not email or p.get("activo") is False or p.get("rol") == "entrenador":
                    continue
                if confirma.get(email) in ("si", "no"):
                    continue
                tid, t = tipo
                precio = float(t.get("precio") or 0)
                batch.set(team.reference.collection("multas").document(), {
                    "jugador": pid, "jugadorNombre": p.get("nombre", ""), "tipo": tid, "tipoNombre": t.get("nombre", ""),
                    "unidad": "fijo", "precio": precio, "cantidad": 1, "importe": precio, "fecha": ev["fecha"],
                    "nota": f"No contestó a la asistencia del entreno de las {ev.get('hora', '')}", "pagada": False,
                    "notificada": False, "creado": int(datetime.now(TZ).timestamp() * 1000), "autor": "plazo"})
                upd["multadosPlazo"].append(pid)
                n += 1
        batch.update(d.reference, upd)
    batch.commit()
    print(f"Plazo cerrado en {len(eventos)} entrenos, {n} multas por no contestar")


def avisar_viernes_equipo(team, toks):
    """Viernes entre las 17:00 y las 21:00: recordatorio del tiro de medio campo, una vez por semana."""
    ahora = datetime.now(TZ)
    t = team.to_dict() or {}
    hoy = ahora.date().isoformat()
    if ahora.weekday() != 4 or not (17 <= ahora.hour < 21) or not t.get("viernes") or t.get("viernesEnviado") == hoy:
        return 0
    toks_ = [tok for tok, info in toks() if info.get("viernes", True)]
    if toks_:
        send(toks_, "🎯 Tiro de medio campo", "Hoy es viernes: el último en meter paga 2 €.", {"tipo": "viernes"}, view="anadir")
    team.reference.update({"viernesEnviado": hoy})
    return 1


MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
         "septiembre", "octubre", "noviembre", "diciembre"]


def avisar_planes(team, toks):
    """Planes nuevos (cenas, lotería…): a todo el equipo menos a quien lo creó."""
    nuevos = list(team.reference.collection("planes")
                  .where(filter=firestore.FieldFilter("notificada", "==", False)).stream())
    for d in nuevos:
        p = d.to_dict() or {}
        body = (p.get("descripcion") or "").strip()
        body = (body[:140] + " · " if body else "") + "Vota y apúntate en la app."
        mensajes = [(tok, f"🎉 Nuevo plan: {p.get('titulo', '')}", body[:200])
                    for tok, info in toks() if info.get("uid") != p.get("autor")]
        send_each(mensajes, data={"tipo": "aviso"}, view="planes")
        d.reference.update({"notificada": True})
    return len(nuevos)


def mes_cobro(fecha):
    """Mes en que hay que pagar una multa: el suyo, salvo las de la última semana, que pasan al siguiente."""
    d = date.fromisoformat(fecha) + timedelta(days=7)
    return f"{d.year}-{d.month:02d}"


def fin_mes(y, m):
    return date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)


def deudas(team, filtro):
    jugadores = {p.id: p.to_dict() or {} for p in team.reference.collection("jugadores").stream()}
    por = {}
    for d in team.reference.collection("multas").where(filter=firestore.FieldFilter("pagada", "==", False)).stream():
        m = d.to_dict() or {}
        if not m.get("fecha") or not filtro(m):
            continue
        pid = m.get("jugador", "")
        nombre = jugadores.get(pid, {}).get("nombre") or m.get("jugadorNombre", "")
        n, t = por.get(pid, (nombre, 0.0))
        por[pid] = (n, t + float(m.get("importe") or 0))
    return por


def pagos_equipo(team, toks):
    """Recordatorio de pago 7 días antes de fin de mes y recargo el día 1 a quien no haya pagado."""
    t = team.to_dict() or {}
    pg = t.get("pagos") or {}
    if not pg.get("activo"):
        return 0
    pct = float(pg.get("pct") or 50)
    minimo = float(pg.get("min") if pg.get("min") is not None else 1)
    ahora = datetime.now(TZ)
    hoy = ahora.date()
    ym = f"{hoy.year}-{hoy.month:02d}"
    fin = fin_mes(hoy.year, hoy.month)
    hecho = 0

    if hoy == fin - timedelta(days=7) and ahora.hour >= 18 and t.get("pagoAviso") != ym:
        pend = deudas(team, lambda m: mes_cobro(m["fecha"]) <= ym)
        cuando = f"{fin.day} de {MESES[fin.month - 1]}"
        mensajes = []
        propietario = str(t.get("propietario", "")).lower()
        emails = {p.id: str((p.to_dict() or {}).get("email", "")).lower() for p in team.reference.collection("jugadores").stream()}
        resumen = ", ".join(f"{nombre_corto(n)} {eur(v)}" for n, v in sorted(pend.values(), key=lambda x: -x[1]))
        for tok, info in toks():
            pid = info.get("jugador", "")
            if pid in pend:
                mensajes.append((tok, f"💶 Tienes {eur(pend[pid][1])} de multas sin pagar",
                                 f"Págalas antes del {cuando}. Si no, se aplicará un recargo del {pct:g} % (mínimo {eur(minimo)})."))
            if pend and propietario and emails.get(pid) == propietario:
                total = sum(v for _, v in pend.values())
                mensajes.append((tok, f"💶 Multas pendientes · {eur(total)}", resumen[:200]))
        send_each(mensajes, data={"tipo": "aviso"}, view="resumen")
        team.reference.update({"pagoAviso": ym})
        hecho += 1

    prev = hoy.replace(day=1) - timedelta(days=1)
    pym = f"{prev.year}-{prev.month:02d}"
    if hoy.day == 1 and ahora.hour >= 10 and t.get("recargoAplicado") != pym:
        pend = deudas(team, lambda m: mes_cobro(m["fecha"]) == pym and m.get("tipo") != "recargo")
        batch = db.batch()
        for pid, (nombre, total) in pend.items():
            if total <= 0:
                continue
            importe = max(minimo, math.ceil(total * pct / 100 * 2) / 2)
            batch.set(team.reference.collection("multas").document(), {
                "jugador": pid, "jugadorNombre": nombre, "tipo": "recargo",
                "tipoNombre": f"Recargo {pct:g} % por no pagar ({MESES[prev.month - 1]})",
                "unidad": "fijo", "precio": importe, "cantidad": 1, "importe": importe, "fecha": hoy.isoformat(),
                "nota": f"Pendiente de {MESES[prev.month - 1]}: {eur(total)}", "pagada": False, "notificada": False,
                "creado": int(ahora.timestamp() * 1000), "autor": "recargo"})
        batch.update(team.reference, {"recargoAplicado": pym})
        batch.commit()
        print(f"::notice::Recargos aplicados: {len(pend)}")
        hecho += 1
    return hecho


def avisar_viernes():
    """Solo a los equipos que tienen activado el recordatorio del viernes."""
    activos = {t.id for t in db.collection("equipos").stream() if (t.to_dict() or {}).get("viernes")}
    toks = [tok for team, lst in tokens_by_team().items() if team in activos
            for tok, info in lst if info.get("viernes", True)]
    if toks:
        send(toks, "🎯 Tiro de medio campo", "Hoy es viernes: el último en meter paga 2 €.", {"tipo": "viernes"}, view="anadir")
    else:
        print("Nadie a quien recordar")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "multas"
    try:
        avisar_viernes() if mode == "viernes" else avisar_multas()
    except Exception as e:
        fail(f"{type(e).__name__}: {str(e)[:500]}")
