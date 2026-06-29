# Sofiisticated

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
