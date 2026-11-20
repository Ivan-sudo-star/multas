"""Envía las notificaciones push de la app de multas.

Lo ejecuta GitHub Actions gratis (ver .github/workflows/avisos.yml):
  python scripts/avisos.py multas    -> avisa de las multas nuevas y de entrenos/partidos
                                        (nuevos, «avisar ahora» y recordatorio del mismo día)
  python scripts/avisos.py viernes   -> recordatorio del tiro de medio campo
Necesita la variable FIREBASE_SERVICE_ACCOUNT (el JSON de la cuenta de servicio)
y, opcionalmente, APP_URL (la dirección de la app, terminada en /).
"""
import json
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
        notification=messaging.WebpushNotification(icon=APP_URL + "icons/icon-192.png"),
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
    print(f"Enviadas {sent}, borrados {len(dead)} móviles inactivos")


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
        print("Nada que avisar")


def avisar_equipo(nombre, multas, tokens):
    mensajes = []
    for tok, info in tokens:
        uid, jug = info.get("uid", ""), info.get("jugador", "")
        mias = [m for m in multas if jug and m.get("jugador") == jug]
        if info.get("solo_mias") and not mias:
            continue
        # A quien ha puesto las multas no se le avisa (salvo si son suyas)
        if not mias and all(m.get("autor") == uid for m in multas):
            continue
        if mias:
            title = "Te han puesto una multa" if len(mias) == 1 else f"Te han puesto {len(mias)} multas"
            body = " / ".join(describe(m) for m in mias)
            otras = len(multas) - len(mias)
            if otras:
                body += f" (+{otras} al resto)"
        elif len(multas) == 1:
            m = multas[0]
            title, body = "Nueva multa", f"{m.get('jugadorNombre', '')} · {describe(m)}"
        else:
            por = {}
            for m in multas:
                n = m.get("jugadorNombre", "?")
                por[n] = por.get(n, 0) + float(m.get("importe") or 0)
            title = f"{len(multas)} multas nuevas"
            body = ", ".join(f"{n} {eur(v)}" for n, v in sorted(por.items(), key=lambda x: -x[1]))
        if nombre:
            title += f" · {nombre}"
        mensajes.append((tok, title, body[:200]))
    send_each(mensajes)


def send_each(mensajes, data=None, view="historial"):
    """Un mensaje distinto para cada móvil."""
    if not mensajes:
        print("Nadie a quien avisar")
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
    print(f"Enviadas {sent}, borrados {len(dead)} móviles inactivos")


TZ = ZoneInfo("Europe/Madrid")
DIAS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
TIPO = {"entreno": "entreno", "partido": "partido"}
RECORDAR_ANTES = timedelta(hours=3)


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
    recordar = {}
    for d in ref.where(filter=F("fecha", "==", hoy.isoformat())).stream():
        ev = d.to_dict() or {}
        if ev.get("recordado"):
            continue
        if ev.get("hora"):
            h, m = (int(x) for x in ev["hora"].split(":")[:2])
            empieza = datetime.combine(hoy, time(h, m), TZ)
            if empieza - RECORDAR_ANTES <= ahora <= empieza + timedelta(hours=1):
                recordar[d.id] = d
        elif ahora.hour >= 10:
            recordar[d.id] = d
    if not (nuevos or pedidos or recordar):
        return 0

    nombre = (team.to_dict() or {}).get("nombre", "")
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
                title = f"Nuevo {tipo} · {nombre}" if nombre else f"Nuevo {tipo}"
                body = f"{que.capitalize()} {cuando(ev, hoy)}."
                if (ev.get("serie") or 0) > 1:
                    body += f" Se repite cada semana ({ev['serie']} semanas)."
                body += " ¿Vas? Contesta en la app."
            else:
                if c == "no":
                    continue
                title = f"Recordatorio: {tipo} {cuando(ev, hoy)}"
                body = "Te esperamos." if c == "si" else "¿Vas? Contesta en la app para que el entrenador sepa cuántos seréis."
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


def avisar_viernes():
    """Solo a los equipos que tienen activado el recordatorio del viernes."""
    activos = {t.id for t in db.collection("equipos").stream() if (t.to_dict() or {}).get("viernes")}
    toks = [tok for team, lst in tokens_by_team().items() if team in activos
            for tok, info in lst if info.get("viernes", True)]
    if toks:
        send(toks, "Tiro de medio campo", "Hoy es viernes: el último en meter paga 2 €.", {"tipo": "viernes"}, view="anadir")
    else:
        print("Nadie a quien recordar")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "multas"
    try:
        avisar_viernes() if mode == "viernes" else avisar_multas()
    except Exception as e:
        fail(f"{type(e).__name__}: {str(e)[:500]}")
