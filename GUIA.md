# Multas Caixa Ontinyent: cómo ponerla en marcha

Es una app web que se instala en el móvil (iPhone y Android) como cualquier otra app, con su icono. Todo es **gratis**: no hace falta tarjeta en ningún paso.

| Pieza | Servicio | Coste |
|---|---|---|
| Datos (jugadores, multas) | Firebase, plan Spark | Gratis (50.000 lecturas al día; el equipo usará unas pocas cientos) |
| Dirección web de la app | GitHub Pages | Gratis |
| Notificaciones push | Firebase Cloud Messaging + GitHub Actions | Gratis (repositorio público) |

Tiempo aproximado: 30 minutos la primera vez.

---

## 1. Crear el proyecto de Firebase

1. Entra en <https://console.firebase.google.com> con una cuenta de Google.
2. **Crear un proyecto** → nombre `multas-ontinyent` → desactiva Google Analytics → Crear.
3. Se queda en el plan **Spark** (gratuito). No lo cambies a Blaze.

## 2. Conectar la app

1. En la página del proyecto pulsa el icono **`</>`** (Web).
2. Apodo: `multas` → **Registrar app** (no marques Firebase Hosting).
3. Te muestra un bloque `firebaseConfig = { apiKey: ..., ... }`.
4. Abre `docs/firebase-config.js` y sustituye los valores de ejemplo por los tuyos. Estos datos no son secretos: es normal que estén en la web.

## 3. Crear la base de datos

1. Menú **Compilación → Firestore Database → Crear base de datos**.
2. Ubicación: `europe-southwest1 (Madrid)` → **Modo de producción** → Crear.
3. Pestaña **Reglas**: borra lo que hay, pega todo el contenido de `firestore.rules` y pulsa **Publicar**.

## 4. Activar el inicio de sesión

1. **Compilación → Authentication → Comenzar**.
2. En **Método de acceso** activa:
   - **Anónimo** (para que cualquiera del equipo pueda ver las multas sin cuenta).
   - **Correo electrónico/contraseña** (para los administradores, que apuntan y cobran).

## 5. Publicar la app en GitHub Pages

1. Crea una cuenta en <https://github.com> si no tienes.
2. **New repository** → nombre `multas` → **Public** → Create.
3. **Add file → Upload files** y arrastra el contenido de la carpeta `multas-caixa-ontinyent`: la carpeta `docs`, la carpeta `scripts`, `firestore.rules` y esta guía → **Commit changes**.
4. La carpeta `.github` está oculta y a veces no se sube al arrastrar. Compruébalo: si no aparece en el repositorio, pulsa **Add file → Create new file**, escribe como nombre `.github/workflows/avisos.yml`, pega el contenido de ese archivo y guarda.
5. **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main`, carpeta `/docs` → Save.
6. Al minuto la app estará en `https://TU-USUARIO.github.io/multas/`.
7. Vuelve a Firebase → **Authentication → Configuración → Dominios autorizados → Agregar dominio** → `TU-USUARIO.github.io`.

## 6. Primer arranque

1. Abre la dirección de la app en el móvil de quien lleva el conteo (Ivan).
2. **Ajustes → Cuenta** → escribe el correo y una contraseña → **Crear cuenta**.
3. Ve a **Resumen** → **Configurar el equipo**. Se cargan los 12 de la plantilla y las 8 multas del grupo, y esa cuenta queda como administradora.
4. Para que otra persona también pueda apuntar multas: esa persona crea su cuenta en su móvil, y después un administrador añade su correo en **Ajustes → Administradores**.

El resto del equipo no necesita cuenta: abre el enlace, ve las multas y lo que debe.

## 7. Instalar la app en el móvil

- **Android (Chrome):** sale el aviso «Instala la app» → **Instalar**. Si no sale: menú ⋮ → *Instalar aplicación* o *Añadir a pantalla de inicio*.
- **iPhone (Safari):** botón **Compartir** → **Añadir a pantalla de inicio**. Tiene que ser desde Safari.

Pasa el enlace por el grupo de WhatsApp para que cada uno la instale.

## 8. Notificaciones push (opcional, gratis)

Llegan al móvil aunque la app esté cerrada: cuando alguien apunta una multa, y los viernes con el recordatorio del tiro de medio campo.

**a) Clave de notificaciones**
1. Firebase → ⚙️ **Configuración del proyecto → Cloud Messaging**.
2. Abajo, **Certificados push web → Generar par de claves**.
3. Copia la clave y pégala en `docs/firebase-config.js`, en `FIREBASE_VAPID_KEY = "..."`. Sube el archivo cambiado a GitHub.

**b) Permiso para que GitHub envíe los avisos**
1. Firebase → ⚙️ **Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada**. Se descarga un archivo `.json`.
2. **Este archivo sí es secreto.** No lo subas nunca al repositorio.
3. En GitHub, en tu repositorio: **Settings → Secrets and variables → Actions**.
   - Pestaña **Secrets** → **New repository secret** → nombre `FIREBASE_SERVICE_ACCOUNT` → pega todo el contenido del `.json` → Add.
   - Pestaña **Variables** → **New repository variable** → nombre `APP_URL` → valor `https://TU-USUARIO.github.io/multas/`.
4. Pestaña **Actions** del repositorio → si lo pide, pulsa *I understand… enable them*. Entra en «Avisos de multas» → **Run workflow** para probar que funciona (debe acabar en verde).
5. Después de probarlo, borra el `.json` de tu ordenador o guárdalo en un sitio seguro.

**c) En cada móvil**
- **Ajustes → Avisos → Activar notificaciones** y aceptar el permiso.
- En iPhone hace falta iOS 16.4 o posterior y tener la app ya instalada en la pantalla de inicio.

**Ten en cuenta:**
- Los avisos de multas nuevas tardan entre 10 y 20 minutos en llegar, porque GitHub revisa cada 10 minutos y a veces se retrasa.
- Con la app abierta, el aviso sale al momento dentro de la app.
- El recordatorio del viernes llega a las 17:00 en invierno y a las 18:00 en verano.

## Cambiar algo de la app más adelante

Edita el archivo en GitHub (lápiz ✏️ → Commit). Si cambias `app.js`, `index.html` o `styles.css`, cambia también en `docs/sw.js` la línea `const CACHE = "multas-v1"` a `multas-v2`, `v3`… para que los móviles descarguen la versión nueva.

## Si algo falla

| Lo que ves | Qué hacer |
|---|---|
| «Falta conectar la base de datos» | Revisa el paso 2: `firebase-config.js` sigue con los valores de ejemplo. |
| «Revisa que el acceso anónimo esté activado» | Paso 4: activa **Anónimo**. |
| «No tienes permiso» al apuntar | Tu correo no está en **Ajustes → Administradores**, o las reglas del paso 3 no están publicadas. |
| Al entrar con correo sale un error de dominio | Paso 5.7: añade `TU-USUARIO.github.io` a los dominios autorizados. |
| No llegan notificaciones | Mira la pestaña **Actions** de GitHub. Si la ejecución sale en rojo, revisa el secreto `FIREBASE_SERVICE_ACCOUNT`. |
