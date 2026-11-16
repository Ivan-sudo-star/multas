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


def send(tokens, title, body, data=None, view="historial"):
    """Envía a todos los móviles y borra los que ya no existen."""
    sent, dead = 0, []
    for i in range(0, len(tokens), 500):
        chunk = tokens[i:i + 500]
        webpush = None
        if APP_URL.startswith("https://"):
            webpush = messaging.WebpushConfig(
                notification=messaging.WebpushNotification(icon=APP_URL + "icons/icon-192.png"),
                fcm_options=messaging.WebpushFCMOptions(link=APP_URL + "#" + view),
            )
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


def avisar_multas():
    nuevas = list(db.collection("multas").where(filter=firestore.FieldFilter("notificada", "==", False)).stream())
    if not nuevas:
        print("No hay multas nuevas")
        return
    multas = [d.to_dict() for d in nuevas]
    autores = {m.get("autor", "") for m in multas}
    # No avisar a quien la ha puesto (si todas son de la misma persona)
    toks = [t for t, info in all_tokens() if not (len(autores) == 1 and info.get("uid") in autores)]
    if len(multas) == 1:
        m = multas[0]
        extra = f" ({m.get('cantidad')} min)" if m.get("unidad") == "minuto" else (f" ×{m.get('cantidad')}" if (m.get("cantidad") or 1) > 1 else "")
        title = "Nueva multa"
        body = f"{m.get('jugadorNombre', '')} · {m.get('tipoNombre', '')}{extra} · {eur(m.get('importe'))}"
    else:
        por = {}
        for m in multas:
            por[m.get("jugadorNombre", "?")] = por.get(m.get("jugadorNombre", "?"), 0) + float(m.get("importe") or 0)
        title = f"{len(multas)} multas nuevas"
        body = ", ".join(f"{n} {eur(v)}" for n, v in sorted(por.items(), key=lambda x: -x[1]))
    if toks:
        send(toks, title, body[:200], {"tipo": "multa"})
    batch = db.batch()
    for d in nuevas:
        batch.update(d.reference, {"notificada": True})
    batch.commit()


def avisar_viernes():
    toks = [t for t, info in all_tokens() if info.get("viernes", True)]
    if toks:
        send(toks, "Tiro de medio campo", "Hoy es viernes: el último en meter paga 2 €.", {"tipo": "viernes"}, view="anadir")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "multas"
    try:
        avisar_viernes() if mode == "viernes" else avisar_multas()
    except Exception as e:
        fail(f"{type(e).__name__}: {str(e)[:500]}")
