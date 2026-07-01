# Sofisticated

Blog de química cosmética hecho con [Eleventy](https://www.11ty.dev/) (genera el sitio) y [Decap CMS](https://decapcms.org/) (panel de edición tipo "Word/Canva" en `/admin`).

El objetivo: cualquiera puede escribir posts nuevos, editar los textos del sitio y subir sus propias fotos desde el navegador, sin tocar código ni Git. Al hacer clic en "Publish" en el panel, el sitio se actualiza solo en 1-2 minutos.

---

## 1. Configuración inicial (solo una vez)

Esto lo hace la persona que mantiene el proyecto (tú). Se hace una sola vez, al lanzar el sitio.

### 1.1 Subir el proyecto a GitHub
Si el código ya está en un repo de GitHub, sigue al paso 1.2.

### 1.2 Crear el sitio en Netlify
1. Entra a [app.netlify.com](https://app.netlify.com) y crea una cuenta (puedes usar tu cuenta de GitHub).
2. **Add new site → Import an existing project** → elige GitHub → selecciona este repositorio.
3. Netlify va a detectar automáticamente la configuración de build gracias al archivo `netlify.toml` (build command `npm run build`, carpeta de salida `_site`). No tienes que tocar nada, solo dale **Deploy**.
4. Cuando termine el primer deploy, te va a dar una URL tipo `https://nombre-random.netlify.app`. Puedes cambiarla en **Site configuration → Domain management** (o conectar tu propio dominio si compraste uno).

### 1.3 Activar Netlify Identity (el sistema de "usuarios")
1. En el panel del sitio en Netlify, ve a **Site configuration → Identity** (o la pestaña "Identity" en el menú).
2. Dale **Enable Identity**.
3. En **Registration**, selecciona **Invite only** (así nadie externo se puede registrar solo).

### 1.4 Activar Git Gateway (para que el CMS pueda publicar cambios)
1. Dentro de Identity, ve a **Services → Git Gateway**.
2. Dale **Enable Git Gateway**. Esto deja que las personas que inicien sesión (vía Identity) puedan guardar cambios en el repo de GitHub sin necesitar su propia cuenta de GitHub.

### 1.5 Invitar a tu novia
1. Dentro de Identity, ve a la pestaña **Users → Invite users**.
2. Escribe su correo y manda la invitación.
3. Ella va a recibir un correo de Netlify con un link para crear su contraseña. Con eso ya puede entrar a `tu-sitio.netlify.app/admin` cuando quiera.

¡Listo! A partir de aquí, todo lo demás lo hace ella sola desde el navegador.

---

## 2. Cómo editar el blog (para Sofia / cualquier persona invitada)

No se necesita saber programar ni usar GitHub. Todo es desde una página web, como llenar un formulario.

1. Entra a **`tu-sitio.netlify.app/admin`** (cambia `tu-sitio` por la URL real del sitio).
2. La primera vez, abre el correo de invitación y crea tu contraseña. Después de eso, solo inicias sesión con tu correo y contraseña.
3. Vas a ver dos secciones en el menú de la izquierda:
   - **Posts del blog** — aquí están todos los posts. Dale **New Post** para crear uno nuevo, o haz clic en cualquiera para editarlo.
   - **Configuración del sitio** — aquí se edita todo lo demás: la portada, la sección "Sobre mí", el newsletter, las redes sociales, etc.
4. Para crear o editar un post, llena los campos (título, categoría, resumen, fecha) y escribe el contenido en el editor de texto — puedes poner negritas, títulos, listas, todo con botones, como en Word.
5. Para poner una imagen, arrástrala al campo de imagen o haz clic para subirla desde tu computadora/celular.
6. Cuando termines, dale **Publish** (arriba a la derecha). En 1-2 minutos el cambio ya está visible en el sitio real.

No hace falta guardar nada más ni avisarle a nadie — publicar desde el panel actualiza el sitio en vivo automáticamente.

---

## 3. Desarrollo local (solo para quien programa)

```bash
npm install     # instala dependencias
npm start       # levanta el sitio en localhost con recarga automática
npm run build   # genera la versión final en _site/
```

Estructura principal:

```
src/
  _data/site.json     # contenido editable de la portada, about, footer, etc.
  _includes/          # layouts (base.njk, post.njk)
  posts/               # un archivo .md por cada post del blog
  admin/               # panel de Decap CMS (config.yml + index.html)
  images/uploads/      # imágenes subidas desde el CMS
.eleventy.js           # configuración de Eleventy (filtros, colecciones)
netlify.toml            # configuración de build para Netlify
```

---

## 4. Correos automáticos cuando publiques un post nuevo

**El formulario de "Subscribe" del sitio ya funciona solo, sin configurar nada.** Los correos de las personas que se suscriban se guardan automáticamente en Netlify: entra a tu panel de Netlify → **Forms → newsletter** y ahí está la lista completa. Puedes activar una notificación (Forms → Form notifications) para que te llegue un aviso cada vez que alguien se suscribe.

Los pasos de abajo (Mailchimp) son el **siguiente nivel, opcional**: sirven para que el aviso de "hay post nuevo" se les mande solo a todos los suscriptores. Si todavía no configuras Mailchimp, no pasa nada — los suscriptores se van guardando en Netlify Forms y los puedes importar a Mailchimp cuando quieras.

El sitio ya genera un feed en **`tu-sitio.netlify.app/feed.xml`** con todos los posts (esto se actualiza solo, no hay que hacer nada). Ese feed es lo que va a usar el servicio de correos para mandar el aviso automático cada vez que publiques algo nuevo — tú no tienes que avisarle a nadie ni mandar el correo a mano.

Esto se configura **una sola vez**. Después de eso, cada vez que le des **Publish** a un post nuevo en el CMS, el correo se manda solo.

### 4.1 Crear cuenta en Mailchimp (gratis)
1. Entra a [mailchimp.com](https://mailchimp.com) y crea una cuenta gratis (el plan gratis alcanza hasta 500 contactos, de sobra para empezar).
2. Cuando te pida crear una **Audience** (audiencia), ponle un nombre como "Sofisticated — suscriptores" y llena los datos básicos que pida (de dónde escribes los correos, etc.).

### 4.2 Crear el formulario de suscripción y conectarlo al sitio
1. En Mailchimp, ve a **Audience → Signup forms → Embedded forms**.
2. Ahí Mailchimp te da un pedazo de código HTML con un `<form>`. Busca la línea que dice algo como:
   ```
   action="https://tudominio.us1.list-manage.com/subscribe/post?u=XXXX&id=YYYY"
   ```
3. Copia **solo esa URL** (la que está entre comillas después de `action=`).
4. Entra al CMS del sitio (`/admin`) → **Configuración del sitio → Newsletter** → pega esa URL en el campo **"Enlace del formulario (Mailchimp)"** → dale **Publish**.
5. Listo — el botón "Subscribe" de la página principal ya manda los correos directo a tu lista de Mailchimp. (Mientras este campo esté vacío, las suscripciones se guardan en Netlify Forms, como se explica arriba — el formulario funciona desde el día uno.)

### 4.3 Conectar el feed del blog para que el correo se mande solo
1. En Mailchimp, ve a **Automations → Create → Classic Automations → RSS**.
2. En "RSS Feed URL" pon: `https://tu-sitio.netlify.app/feed.xml` (o tu dominio real, ej. `https://sofisticated.lat/feed.xml`).
3. Elige cada cuánto quieres que Mailchimp revise si hay posts nuevos (lo más simple: **Daily**, una vez al día — si publicaste algo ese día, se manda el correo; si no, no se manda nada).
4. Elige la audiencia que creaste en el paso 4.1.
5. En el paso de diseño del correo, elige **Code your own → Paste in code**, y pega todo el contenido del archivo [`email-templates/new-post-notification.html`](./email-templates/new-post-notification.html) de este repo. Esa plantilla ya tiene el diseño con los colores y la tipografía del sitio, y usa las variables de Mailchimp (`*|RSS:ITEM:TITLE|*`, etc.) para llenarse sola con cada post nuevo.
6. Guarda y activa la automatización (**Start Sending**).

A partir de aquí, cada vez que publiques un post nuevo desde el CMS, las personas suscritas reciben automáticamente un correo con el título, la imagen, el resumen y un botón para leer el post completo — sin que tengas que hacer nada extra.

> Para ver cómo se ve el correo antes de configurarlo, pídele a quien programó el sitio que te mande una vista previa (`email-templates/new-post-notification.html` abierto en el navegador, con datos de ejemplo).
