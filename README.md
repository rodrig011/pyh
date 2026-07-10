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

Los pasos de abajo (Brevo) son el **siguiente nivel, opcional**: sirven para que el aviso de "hay post nuevo" se les mande solo a todos los suscriptores. Si todavía no configuras Brevo, no pasa nada — los suscriptores se van guardando en Netlify Forms y los puedes importar a Brevo cuando quieras (en Brevo: **Contacts → Import contacts**).

El sitio ya genera un feed en **`tu-sitio.netlify.app/feed.xml`** con todos los posts (esto se actualiza solo, no hay que hacer nada). Ese feed es lo que va a usar Brevo para mandar el aviso automático cada vez que publiques algo nuevo — tú no tienes que avisarle a nadie ni mandar el correo a mano.

Esto se configura **una sola vez**. Después de eso, cada vez que le des **Publish** a un post nuevo en el CMS, el correo se manda solo.

### 4.1 Crear cuenta en Brevo (gratis)
1. Entra a [brevo.com](https://www.brevo.com) y crea una cuenta gratis (el plan gratis permite hasta 300 correos al día, de sobra para empezar).
2. En **Contacts → Lists**, crea una lista llamada "Sofisticated — suscriptores". Ahí van a caer las personas que se suscriban.

### 4.2 Crear el formulario de suscripción y conectarlo al sitio
1. En Brevo, ve a **Contacts → Forms** (formularios de suscripción) y crea un formulario nuevo, conectado a la lista que creaste en 4.1.
2. Cuando lo termines, en el paso de compartir/integrar elige la opción de **código HTML** (iframe/HTML). Busca en el código la línea del `<form>` que dice algo como:
   ```
   action="https://xxxxxxxx.sibforms.com/serve/XXXXXXXX"
   ```
3. Copia **solo esa URL** (la que está entre comillas después de `action=`).
4. Entra al CMS del sitio (`/admin`) → **Configuración del sitio → Newsletter** → pega esa URL en el campo **"Enlace del formulario (Brevo)"** → dale **Publish**.
5. Listo — el botón "Subscribe" de la página principal ya manda los correos directo a tu lista de Brevo. (Mientras este campo esté vacío, las suscripciones se guardan en Netlify Forms, como se explica arriba — el formulario funciona desde el día uno.)

### 4.3 Conectar el feed del blog para que el correo se mande solo
1. En Brevo, busca la app **"RSS Campaign"** (menú de apps / App Store de Brevo) e instálala.
2. En "RSS feed URL" pon: `https://sofisticated.lat/feed.xml` (o la URL real de tu sitio en Netlify).
3. Elige cada cuánto revisa si hay posts nuevos (lo más simple: **una vez al día** — si publicaste algo ese día, se manda el correo; si no, no se manda nada) y elige la lista del paso 4.1.
4. En el diseño del correo, usa la opción de **pegar código HTML** y pega todo el contenido del archivo [`email-templates/new-post-notification.html`](./email-templates/new-post-notification.html) de este repo. Esa plantilla ya tiene el diseño con los colores y la tipografía del sitio, y usa las variables de Brevo (`{{ item.TITLE }}`, `{{ item.LINK }}`, etc.) para llenarse sola con cada post nuevo. Si prefieres el editor visual de Brevo, marca el bloque del post como **contenido repetible** con `Repeat for: items` y `alias: item`.
5. Guarda y activa la campaña.

A partir de aquí, cada vez que publiques un post nuevo desde el CMS, las personas suscritas reciben automáticamente un correo con el título, el resumen y un botón para leer el post completo — sin que tengas que hacer nada extra.

> Para ver cómo se ve el correo antes de configurarlo, pídele a quien programó el sitio que te mande una vista previa (`email-templates/new-post-notification.html` abierto en el navegador, con datos de ejemplo).

> **Nota:** la captura automática de suscriptores en Netlify Forms solo funciona mientras el sitio esté hosteado en Netlify. Si el sitio se mueve a Cloudflare Pages (sección 5), configura el formulario de Brevo (paso 4.2) — es gratis y es la solución permanente.

---

## 5. Si Netlify se queda sin créditos: hosting gratis en Cloudflare Pages

El plan gratis de Netlify tiene un límite mensual de "créditos" de build (cada Publish del CMS gasta uno). Si se acaban, los deploys se pausan hasta el próximo mes — los cambios se siguen guardando en GitHub y **no se pierde nada**, solo dejan de aparecer en el sitio hasta que se reinician los créditos.

La alternativa gratis y más holgada es **Cloudflare Pages** (500 builds al mes, tráfico ilimitado). El panel de edición (`/admin`) usa DecapBridge, que **no depende de Netlify**, así que después de la mudanza todo se sigue editando igual.

### 5.1 Conectar el repo a Cloudflare Pages
1. Crea una cuenta gratis en [dash.cloudflare.com](https://dash.cloudflare.com).
2. Ve a **Workers & Pages → Create → Pages → Connect to Git** y autoriza GitHub, eligiendo este repositorio.
3. En la configuración del build pon:
   - **Build command:** `npm run build`
   - **Build output directory:** `_site`
   - En **Environment variables** agrega `NODE_VERSION` = `20`.
4. Dale **Save and Deploy**. En un minuto tienes el sitio en una URL tipo `nombre.pages.dev`.

### 5.2 Apuntar el dominio (sofisticated.lat)
1. En el proyecto de Pages, ve a **Custom domains → Set up a custom domain** y escribe `sofisticated.lat`.
2. Cloudflare te va a pedir cambiar los **nameservers** del dominio a los suyos (te muestra cuáles). Ese cambio se hace donde esté registrado el dominio (si fue comprado vía Netlify: Netlify → Domains → tu dominio → Name servers).
3. Espera a que propague (minutos a unas horas). Listo — el sitio queda servido gratis por Cloudflare y cada Publish del CMS lo actualiza igual que antes.

> El archivo `src/_headers` del repo ya trae la configuración de caché y seguridad en el formato de Cloudflare, así que no hay que configurar nada más. El `netlify.toml` se queda por si algún día se vuelve a Netlify.
