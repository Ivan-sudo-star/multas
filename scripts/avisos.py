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
import re
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


def notas_pendientes():
    """Notas de scouting sin avisar de todos los equipos con UNA consulta (necesita un índice; si falta, None)."""
    try:
        por = {}
        for n in db.collection_group("notas").where(filter=firestore.FieldFilter("notificada", "==", False)).stream():
            team_id = n.reference.parent.parent.parent.parent.id
            por.setdefault(team_id, []).append(n)
        return por
    except Exception as e:
        print(f"::notice::Para gastar menos lecturas, crea el índice que pide Firebase: {str(e)[:300]}")
        return None


def avisar_multas():
    toks_team = None
    total = 0
    pend_notas = notas_pendientes()
    for team in db.collection("equipos").stream():
        def toks(team_id=team.id):
            nonlocal toks_team
            if toks_team is None:
                toks_team = tokens_by_team()
            return toks_team.get(team_id, [])
        total += avisar_eventos(team, toks)
        total += avisar_tablon(team, toks)
        total += avisar_tablon_admins(team, toks)
        total += avisar_viernes_equipo(team, toks)
        total += avisar_planes(team, toks)
        total += pagos_equipo(team, toks)
        total += aviso_fichajes(team, toks)
        total += avisar_scouting(team, toks, None if pend_notas is None else pend_notas.get(team.id, []))
        total += recordatorios_pago(team, toks)
        total += avisar_convocatoria(team, toks)
        total += cumpleanos(team, toks)
        total += previa_partido(team, toks)
        total += fantasy_equipo(team, toks)
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
    total += sugerencias_semanales()
    total += recordatorio_fbcv()
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


def avisar_tablon_admins(team, toks):
    """Avisos del tablón marcados «solo administradores»: la notificación solo les llega a ellos."""
    nuevos = list(team.reference.collection("avisosAdmin").where(filter=firestore.FieldFilter("notificada", "==", False)).stream())
    if not nuevos:
        return 0
    t = team.to_dict() or {}
    admins = {str(a).lower() for a in t.get("admins", [])}
    emails = {p.id: str((p.to_dict() or {}).get("email", "")).lower() for p in team.reference.collection("jugadores").stream()}
    for d in nuevos:
        a = d.to_dict() or {}
        msgs = [(tok, f"🛡️ Para administradores · {a.get('autorNombre') or ''}".strip(" ·"), str(a.get("texto", ""))[:450])
                for tok, info in toks() if emails.get(info.get("jugador", "")) in admins]
        send_each(msgs, data={"tipo": "aviso"}, view="resumen")
        d.reference.update({"notificada": True})
    return len(nuevos)


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
    fijo = pg.get("tipo") == "fijo"
    cant_fija = float(pg.get("fijo") or 2)
    texto_recargo = f"un recargo de {eur(cant_fija)}" if fijo else f"un recargo del {pct:g} % (mínimo {eur(minimo)})"
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
                                 f"Págalas antes del {cuando}. Si no, se aplicará {texto_recargo}."))
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
            importe = cant_fija if fijo else max(minimo, math.ceil(total * pct / 100 * 2) / 2)
            batch.set(team.reference.collection("multas").document(), {
                "jugador": pid, "jugadorNombre": nombre, "tipo": "recargo",
                "tipoNombre": (f"Recargo por no pagar ({MESES[prev.month - 1]})" if fijo
                               else f"Recargo {pct:g} % por no pagar ({MESES[prev.month - 1]})"),
                "unidad": "fijo", "precio": importe, "cantidad": 1, "importe": importe, "fecha": hoy.isoformat(),
                "nota": f"Pendiente de {MESES[prev.month - 1]}: {eur(total)}", "pagada": False, "notificada": False,
                "creado": int(ahora.timestamp() * 1000), "autor": "recargo"})
        batch.update(team.reference, {"recargoAplicado": pym})
        batch.commit()
        print(f"::notice::Recargos aplicados: {len(pend)}")
        hecho += 1
    return hecho


def avisar_scouting(team, toks, pendientes=None):
    """Notas de scouting nuevas: a todo el equipo (también a quien la escribe), agrupadas por rival."""
    enviados = 0
    if pendientes is None:   # sin índice: se revisa rival por rival (más lecturas)
        grupos = []
        for r in team.reference.collection("rivales").stream():
            nuevas = list(r.reference.collection("notas").where(filter=firestore.FieldFilter("notificada", "==", False)).stream())
            if nuevas:
                grupos.append((r, nuevas))
    else:
        por_rival = {}
        for n in pendientes:
            por_rival.setdefault(n.reference.parent.parent.id, []).append(n)
        grupos = [(team.reference.collection("rivales").document(rid).get(), ns) for rid, ns in por_rival.items()]
    for r, nuevas in grupos:
        rv = r.to_dict() or {}
        plantilla = rv.get("plantilla") or {}
        notas = [n.to_dict() or {} for n in nuevas]
        title = f"🔎 Scouting · {rv.get('nombre', 'rival')}"
        if len(notas) == 1:
            n = notas[0]
            j = plantilla.get(n.get("jugador", "")) or {}
            quien = (f"#{j['dorsal']} " if j.get("dorsal") not in (None, "") else "") + str(j.get("nombre", "")).title() if j else "Equipo"
            body = f"{nombre_corto(n.get('nombre'))} sobre {quien}: {n.get('texto', '')}"
        else:
            autores = sorted({nombre_corto(n.get("nombre")) for n in notas})
            body = f"{len(notas)} notas nuevas de {', '.join(autores)}. Míralas antes del partido."
        send_each([(tok, title, body[:200]) for tok, _ in toks()], data={"tipo": "aviso"}, view="scouting")
        batch = db.batch()
        for n in nuevas:
            batch.update(n.reference, {"notificada": True})
        batch.commit()
        enviados += 1
    return enviados


def previa_partido(team, toks):
    """El día antes de cada partido, a partir de las 19:00: recordar el scouting del rival a todo el equipo."""
    ahora = datetime.now(TZ)
    if ahora.hour < 19:
        return 0
    manana = (ahora.date() + timedelta(days=1)).isoformat()
    hechos = 0
    for d in team.reference.collection("eventos").where(filter=firestore.FieldFilter("fecha", "==", manana)).stream():
        ev = d.to_dict() or {}
        if ev.get("tipo") != "partido" or not ev.get("rival") or ev.get("scoutPrevia"):
            continue
        r = team.reference.collection("rivales").document(ev["rival"]).get()
        if not r.exists:
            continue
        notas = [x.to_dict() or {} for x in r.reference.collection("notas").stream()]
        n = len(notas)
        rv = r.to_dict() or {}
        nombre = rv.get("nombre", "el rival")
        hora = f" a las {ev['hora']}" if ev.get("hora") else ""
        title = f"🔎 Mañana{hora} contra {nombre}"
        body = (f"Hay {n} nota{'s' if n != 1 else ''} de scouting. Échales un vistazo antes del partido."
                if n else "Todavía no hay notas de scouting. Si sabes algo de ellos, apúntalo en la app.")
        mensajes = [(tok, title, body) for tok, _ in toks()]
        # Partido de vuelta: lo que apuntamos después de la ida
        ida = [x for x in sorted(notas, key=lambda x: x.get("creado") or 0) if x.get("partido")]
        if ida:
            txt = " · ".join(re.sub(r"^Tras el partido del [^:]+:\s*", "", x.get("texto", "")) for x in ida)
            mensajes += [(tok, f"🔁 Para la vuelta contra {nombre}", ("En la ida apuntamos: " + txt)[:450]) for tok, _ in toks()]
        # Claves de sus jugadores: notas con dorsal y el máximo anotador
        claves = claves_rival(ev["rival"], rv, notas)
        if claves:
            mensajes += [(tok, f"👀 Claves de {nombre}", claves[:450]) for tok, _ in toks()]
        send_each(mensajes, data={"tipo": "aviso"}, view="scouting")
        d.reference.update({"scoutPrevia": True})
        hechos += 1
    return hechos


def tokens_propietario():
    """Móviles del propietario de la app (propietario del equipo ONTINYENT)."""
    owner = str((db.collection("equipos").document("ONTINYENT").get().to_dict() or {}).get("propietario", "")).lower()
    if not owner:
        return []
    cache, out = {}, []
    for tok, info in all_tokens():
        team = info.get("equipo") or LEGACY_TEAM
        if team not in cache:
            cache[team] = {p.id: str((p.to_dict() or {}).get("email", "")).lower()
                           for p in db.collection("equipos").document(team).collection("jugadores").stream()}
        if cache[team].get(info.get("jugador", "")) == owner:
            out.append(tok)
    return out


def recordatorio_fbcv():
    """Lunes desde las 10:00: recordar al propietario que renueve los datos de la FBCV.
    Si a los 2 días no está hecho, se repite (cada 2 días hasta el domingo)."""
    ahora = datetime.now(TZ)
    if ahora.hour < 10:
        return 0
    hoy = ahora.date()
    lunes = (hoy - timedelta(days=hoy.weekday())).isoformat()
    eq = db.collection("equipos").document("ONTINYENT").get().to_dict() or {}
    hecho = max(str(stats_fbcv().get("copiado", "")), str(eq.get("fbcvRenovado", "")))
    if hecho >= lunes:
        return 0
    est_ref = db.collection("app").document("estado")
    est = est_ref.get().to_dict() or {}
    ultimo = str(est.get("fbcvAviso", ""))
    if ultimo >= lunes and (hoy - date.fromisoformat(ultimo)).days < 2:
        return 0
    segundo = ultimo >= lunes
    est_ref.set({"fbcvAviso": hoy.isoformat()}, merge=True)
    toks = tokens_propietario()
    if not toks:
        return 0
    title = "🔄 Recuerda: renovar datos de la FBCV" if segundo else "🔄 Toca renovar los datos de la FBCV"
    body = ("Aún no está hecho. " if segundo else "") + \
        "Estadísticas, clasificación y plantillas de cada jugador. Cuando esté, pulsa «Ya está renovado» en Ajustes."
    send_each([(t, title, body) for t in toks], data={"tipo": "aviso"}, view="ajustes")
    return 1


def sugerencias_semanales():
    """Domingo desde las 10:00: resumen de sugerencias de mejora, solo para el propietario de la app."""
    ahora = datetime.now(TZ)
    hoy = ahora.date().isoformat()
    if ahora.weekday() != 6 or ahora.hour < 10:
        return 0
    est_ref = db.collection("app").document("estado")
    est = est_ref.get().to_dict() or {}
    if est.get("sugSemana") == hoy:
        return 0
    pend = list(db.collection("sugerencias").where(filter=firestore.FieldFilter("enviada", "==", False)).stream())
    est_ref.set({"sugSemana": hoy}, merge=True)
    if not pend:
        return 0
    owner = str((db.collection("equipos").document("ONTINYENT").get().to_dict() or {}).get("propietario", "")).lower()
    sugs = [d.to_dict() or {} for d in pend]
    body = " ".join(f"• {x.get('texto', '')[:60]} ({nombre_corto(x.get('nombre'))}, {x.get('rol', '?')} · {x.get('equipoNombre') or x.get('equipo') or '?'})" for x in sugs)
    title = f"💡 {len(sugs)} sugerencia{'s' if len(sugs) != 1 else ''} de mejora esta semana"
    cache, mensajes = {}, []
    for tok, info in all_tokens():
        team = info.get("equipo") or LEGACY_TEAM
        if team not in cache:
            cache[team] = {p.id: str((p.to_dict() or {}).get("email", "")).lower()
                           for p in db.collection("equipos").document(team).collection("jugadores").stream()}
        if owner and cache[team].get(info.get("jugador", "")) == owner:
            mensajes.append((tok, title, body[:200]))
    send_each(mensajes, data={"tipo": "aviso"}, view="ajustes")
    batch = db.batch()
    for d in pend:
        batch.update(d.reference, {"enviada": True})
    batch.commit()
    return 1


def fantasy_equipo(team, toks):
    """Fantasy: aviso para hacer el quinteto, apertura de notas y cierre de la jornada con puntos y precios."""
    t = team.to_dict() or {}
    cfg = t.get("fantasy") or {}
    if not cfg.get("activo"):
        return 0
    presupuesto = float(cfg.get("presupuesto") or 50)
    ahora = datetime.now(TZ)
    hoy = ahora.date()
    desde, hasta = (hoy - timedelta(days=4)).isoformat(), (hoy + timedelta(days=1)).isoformat()
    F = firestore.FieldFilter
    evs = [d for d in team.reference.collection("eventos").where(filter=F("fecha", ">=", desde)).where(filter=F("fecha", "<=", hasta)).stream()
           if (d.to_dict() or {}).get("tipo") == "partido" and (d.to_dict() or {}).get("hora")]
    if not evs:
        return 0
    jug = {p.id: p.to_dict() or {} for p in team.reference.collection("jugadores").stream()}
    email_de = {pid: str(p.get("email", "")).lower() for pid, p in jug.items()}
    pid_de = {e: pid for pid, e in email_de.items() if e}
    participantes = {pid for pid, p in jug.items() if p.get("email") and p.get("activo") is not False and p.get("rol") != "entrenador"}
    entrenadores = {pid for pid, p in jug.items() if p.get("email") and p.get("rol") == "entrenador"}
    tokens = toks()
    hecho = 0
    for d in evs:
        ev = d.to_dict() or {}
        start = inicio(ev)
        jref = team.reference.collection("jornadas").document(d.id)
        rival = (ev.get("nota") or "").replace("en casa contra ", "").replace("fuera contra ", "") or "el rival"
        if ev.get("rival"):
            rd = team.reference.collection("rivales").document(ev["rival"]).get()
            if rd.exists:
                rival = (rd.to_dict() or {}).get("nombre", rival)
        upd = {}
        # A) 3 h antes: a quien no tiene quinteto
        if start - timedelta(hours=3) <= ahora < start and not ev.get("fanAviso"):
            con = {a.id for a in jref.collection("alineaciones").stream()}
            falta = {pid for pid in participantes if email_de[pid] not in con}
            msgs = [(tok, "🏀 Fantasy: haz tu quinteto", f"Contra {rival}. Se cierra {hora_txt(start, hoy)}.")
                    for tok, info in tokens if info.get("jugador") in falta]
            send_each(msgs, data={"tipo": "aviso"}, view="fantasy")
            upd["fanAviso"] = True
        # B) 2 h después del inicio: abrir notas (jugadores y entrenador)
        if start + timedelta(hours=2) <= ahora < start + timedelta(hours=48) and not ev.get("fanNotas"):
            fin = start + timedelta(hours=48)
            msgs = [(tok, "⭐ Pon nota a tus compañeros", f"Partido contra {rival}. Notas de −2 a 10 y MVP, anónimas. Hasta {hora_txt(fin, hoy)}.")
                    for tok, info in tokens if info.get("jugador") in participantes | entrenadores]
            send_each(msgs, data={"tipo": "aviso"}, view="fantasy")
            upd["fanNotas"] = True
        # B2) 8 h antes de que se cierren las notas: a quien aún no ha votado
        if start + timedelta(hours=40) <= ahora < start + timedelta(hours=48) and not ev.get("fanNotasRec"):
            votaron = {v.id for v in jref.collection("votos").stream()}
            faltan = {pid for pid in participantes | entrenadores if email_de.get(pid) not in votaron}
            fin = start + timedelta(hours=48)
            msgs = [(tok, "⭐ Te quedan 8 horas para poner notas", f"Partido contra {rival}. Se cierra {hora_txt(fin, hoy)}.")
                    for tok, info in tokens if info.get("jugador") in faltan]
            send_each(msgs, data={"tipo": "aviso"}, view="fantasy")
            upd["fanNotasRec"] = True
        # C) 48 h después: cerrar la jornada
        if start + timedelta(hours=48) <= ahora < start + timedelta(days=7) and not ev.get("fanCerrada"):
            fantasy_cerrar(team, d.id, ev, start, rival, jug, email_de, pid_de, participantes, presupuesto, tokens)
            upd["fanCerrada"] = True
        if upd:
            d.reference.update(upd)
            hecho += 1
    return hecho


def fantasy_cerrar(team, evid, ev, start, rival, jug, email_de, pid_de, participantes, presupuesto, tokens):
    est_ref = team.reference.collection("fantasy").document("estado")
    est = est_ref.get().to_dict() or {}
    precios = {k: float(v) for k, v in (est.get("precios") or {}).items()}
    pr = lambda pid: precios.get(pid, 10.0)
    jref = team.reference.collection("jornadas").document(evid)
    jugables = {pid for pid, p in jug.items() if p.get("activo") is not False and p.get("rol") != "entrenador"}
    asis, conf = ev.get("asistencia") or {}, ev.get("confirma") or {}
    if asis:
        jugaron = {pid for pid in jugables if asis.get(pid) in ("si", "tarde")}
    else:
        jugaron = {pid for pid in jugables if email_de.get(pid) and conf.get(email_de[pid]) == "si"}
    limite_votos = start + timedelta(hours=48)
    notas, mvps = {pid: [] for pid in jugaron}, {}
    for v in jref.collection("votos").stream():
        x = v.to_dict() or {}
        ts = x.get("actualizado")
        if ts and ts > limite_votos:
            continue
        yo = pid_de.get(v.id)
        es_entrenador = jug.get(yo, {}).get("rol") == "entrenador"
        for pid, n in ({} if es_entrenador else (x.get("notas") or {})).items():
            if pid in notas and pid != yo and isinstance(n, (int, float)) and -2 <= n <= 10:
                notas[pid].append(float(n))
        m = x.get("mvp")
        if m in jugaron and m != yo:
            mvps[m] = mvps.get(m, 0) + 1
    media = {pid: (round(sum(ns) / len(ns), 1) if ns else 5.0) for pid, ns in notas.items()}
    mvp = max(mvps, key=lambda p: (mvps[p], media.get(p, 0))) if mvps else None
    puntos = {pid: (media[pid] + (3 if pid == mvp else 0) if pid in jugaron else 0.0) for pid in jugables}
    # Quintetos válidos: guardados antes del inicio, de participantes, 5 jugadores, capitán y dentro de presupuesto
    alins = {}
    for a in jref.collection("alineaciones").stream():
        x = a.to_dict() or {}
        ts = x.get("actualizado")
        js = [p for p in (x.get("jugadores") or []) if p in jugables]
        if not ts or ts > start or pid_de.get(a.id) not in participantes or len(set(js)) != 5 or x.get("capitan") not in js:
            continue
        if sum(pr(p) for p in js) > presupuesto + 0.01:
            continue
        alins[a.id] = (js, x.get("capitan"), x.get("nombre", ""))
    n = len(alins) or 1
    owner = {pid: sum(1 for js, _, _ in alins.values() if pid in js) / n for pid in jugables}
    resultados = {}
    for em, (js, cap, _) in alins.items():
        resultados[em] = round(sum(puntos[p] for p in js) + puntos[cap] + sum(1 for p in js if owner[p] <= 0.25), 1)
    # Precios: suben o bajan según la jornada
    for pid in jugables:
        if pid in jugaron:
            precios[pid] = min(20.0, max(4.0, round((pr(pid) + (puntos[pid] - 6) * 0.3) * 2) / 2))
        else:
            precios[pid] = max(4.0, pr(pid) - 0.5)
    clas = est.get("clasificacion") or {}   # por jugador (id), para poder importar ligas anteriores
    for em, pts in resultados.items():
        pid = pid_de.get(em, em)
        c = clas.get(pid) or {}
        nombre = jug.get(pid, {}).get("nombre") or alins[em][2] or em
        clas[pid] = {"nombre": nombre, "total": round(float(c.get("total", 0)) + pts, 1), "jornadas": int(c.get("jornadas", 0)) + 1, "ultima": pts}
    ganador = max(resultados, key=resultados.get) if resultados else None
    ultima = {"rival": rival, "fecha": ev.get("fecha"), "mvpNombre": jug.get(mvp, {}).get("nombre", "") if mvp else "",
              "ganador": (clas.get(pid_de.get(ganador, ganador)) or {}).get("nombre", "") if ganador else "", "ganadorPts": resultados.get(ganador) if ganador else None}
    jref.set({"cerrada": True, "rival": rival, "fecha": ev.get("fecha"), "puntos": puntos, "mvp": mvp, "resultados": resultados})
    hist = est.get("precioHist") or {}
    for pid, pr_ in precios.items():
        h = list(hist.get(pid) or [])
        h.append({"f": ev.get("fecha"), "p": pr_})
        hist[pid] = h[-30:]
    est_ref.set({"precios": precios, "clasificacion": clas, "ultima": ultima, "precioHist": hist}, merge=True)
    partes = ([f"MVP: {nombre_corto(ultima['mvpNombre'])}"] if mvp else []) + \
        ([f"Ganó {nombre_corto(ultima['ganador'])} con {ultima['ganadorPts']} pts"] if ganador else ["Nadie hizo quinteto"])
    body = " · ".join(partes) + ". Mira la clasificación."
    send_each([(tok, f"🏆 Fantasy · {rival}", body[:200]) for tok, _ in tokens], data={"tipo": "aviso"}, view="fantasy")
    print(f"::notice::Fantasy cerrado ({rival}): {len(alins)} quintetos, MVP {mvp}")


def recordatorios_pago(team, toks):
    """«Recordar pago» que pulsa el administrador: notificación solo a ese jugador."""
    pend = list(team.reference.collection("recordatorios").where(filter=firestore.FieldFilter("enviado", "==", False)).stream())
    for d in pend:
        x = d.to_dict() or {}
        msgs = [(tok, "💶 Tienes multas sin pagar", f"Debes {eur(x.get('importe'))}. Págaselas a quien lleva el conteo, en efectivo.")
                for tok, info in toks() if info.get("jugador") == x.get("jugador")]
        send_each(msgs, data={"tipo": "aviso"}, view="resumen")
        d.reference.update({"enviado": True})
    return len(pend)


def avisar_convocatoria(team, toks):
    """Convocatoria de partido: aviso a cada convocado."""
    pend = list(team.reference.collection("eventos").where(filter=firestore.FieldFilter("convocAviso", "==", False)).stream())
    hoy = datetime.now(TZ).date()
    for d in pend:
        ev = d.to_dict() or {}
        conv = set(ev.get("convocados") or [])
        rival = (ev.get("nota") or "").replace("en casa contra ", "").replace("fuera contra ", "") or "el rival"
        body = f"Partido contra {rival} {cuando(ev, hoy)}." + (f" 📍 {ev['lugar']}" if ev.get("lugar") else "")
        send_each([(tok, "📋 Estás convocado", body[:200]) for tok, info in toks() if info.get("jugador") in conv],
                  data={"tipo": "evento"}, view="asistencia")
        d.reference.update({"convocAviso": True})
    return len(pend)


def cumpleanos(team, toks):
    """Desde las 9:00: aviso al equipo de los cumpleaños del día (una vez al día)."""
    ahora = datetime.now(TZ)
    hoy = ahora.date().isoformat()
    t = team.to_dict() or {}
    if ahora.hour < 9 or t.get("cumpleAviso") == hoy:
        return 0
    team.reference.update({"cumpleAviso": hoy})
    hoy_md = hoy[5:]
    cumple = [p.to_dict() or {} for p in team.reference.collection("jugadores").stream()]
    cumple = [p for p in cumple if str(p.get("cumple", ""))[5:] == hoy_md and p.get("activo") is not False]
    if not cumple:
        return 0
    nombres = " y ".join(nombre_corto(p.get("nombre")) for p in cumple)
    send_each([(tok, f"🎂 ¡Hoy es el cumple de {nombres}!", "No te olvides de felicitarle 🎉") for tok, _ in toks()],
              data={"tipo": "aviso"}, view="resumen")
    return 1


_STATS = None


def stats_fbcv():
    """Estadísticas copiadas de la FBCV (docs/fbcv-stats.json del propio repositorio)."""
    global _STATS
    if _STATS is None:
        try:
            ruta = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "fbcv-stats.json")
            with open(ruta, encoding="utf-8") as f:
                _STATS = json.load(f)
        except Exception:
            _STATS = {}
    return _STATS


def _clave(n):
    import unicodedata
    n = unicodedata.normalize("NFD", str(n or "").upper())
    return " ".join("".join(c for c in n if unicodedata.category(c) != "Mn").replace(".", " ").split())


def claves_rival(rid, rv, notas):
    plantilla = rv.get("plantilla") or {}
    partes = []
    for x in sorted(notas, key=lambda x: x.get("creado") or 0):
        j = plantilla.get(x.get("jugador") or "")
        if not j:
            continue
        dor = f"#{j['dorsal']} " if j.get("dorsal") not in (None, "") else ""
        partes.append(f"{dor}{nombre_corto(j.get('nombre'))}: {x.get('texto', '')}")
    stats = (stats_fbcv().get("rivales") or {}).get(str(rid).replace("fbcv-", "")) or []
    if stats:
        top = max(stats, key=lambda s: s.get("pts", 0))
        dor = ""
        for j in plantilla.values():
            a, b = _clave(j.get("nombre")), _clave(top.get("n"))
            if a and (a == b or b.startswith(a + " ")) and j.get("dorsal") not in (None, ""):
                dor = f"#{j['dorsal']} "
        partes.append(f"Máximo anotador: {dor}{nombre_corto(top.get('n'))} ({top.get('pts')} pts/partido)")
    return " · ".join(partes)


def aviso_fichajes(team, toks):
    """Día 1 de cada mes a partir de las 10:00: recordar a los administradores que revisen fichajes en la FBCV."""
    ahora = datetime.now(TZ)
    t = team.to_dict() or {}
    ym = f"{ahora.year}-{ahora.month:02d}"
    if ahora.day != 1 or ahora.hour < 10 or t.get("fichajesAviso") == ym:
        return 0
    rivales = [r for r in team.reference.collection("rivales").stream() if (r.to_dict() or {}).get("fbcv")]
    if not rivales:
        return 0
    admins = {str(a).lower() for a in t.get("admins", [])}
    emails = {p.id: str((p.to_dict() or {}).get("email", "")).lower() for p in team.reference.collection("jugadores").stream()}
    mensajes = [(tok, "🔄 Revisa los fichajes de los rivales",
                 f"Empieza {MESES[ahora.month - 1]}: mira en la FBCV si algún rival ha fichado y añádelo en Scouting.")
                for tok, info in toks() if emails.get(info.get("jugador", "")) in admins]
    send_each(mensajes, data={"tipo": "aviso"}, view="scouting")
    team.reference.update({"fichajesAviso": ym})
    return 1


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
