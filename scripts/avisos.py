"""Envía las notificaciones push de la app de multas.

Lo ejecuta GitHub Actions gratis (ver .github/workflows/avisos.yml):
  python scripts/avisos.py multas    -> avisa de las multas nuevas
  python scripts/avisos.py viernes   -> recordatorio del tiro de medio campo
Necesita la variable FIREBASE_SERVICE_ACCOUNT (el JSON de la cuenta de servicio)
y, opcionalmente, APP_URL (la dirección de la app, terminada en /).
"""
import json
import os
import sys

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
        nuevas = list(team.reference.collection("multas")
                      .where(filter=firestore.FieldFilter("notificada", "==", False)).stream())
        if not nuevas:
            continue
        total += len(nuevas)
        if toks_team is None:
            toks_team = tokens_by_team()
        nombre = (team.to_dict() or {}).get("nombre", "")
        avisar_equipo(nombre, [d.to_dict() for d in nuevas], toks_team.get(team.id, []))
        batch = db.batch()
        for d in nuevas:
            batch.update(d.reference, {"notificada": True})
        batch.commit()
    if not total:
        print("No hay multas nuevas")


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
