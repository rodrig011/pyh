# Bots de Discord: VIP con pagos Zelle + canal solo-fotos

Dos bots independientes en un mismo proyecto:

1. **Bot VIP** — vende tres niveles de membresia que se pagan por Zelle. Cada compra
   genera un **codigo aleatorio** que el comprador escribe en la nota del Zelle; el bot
   lee el correo del banco, encuentra el codigo, y entrega los roles automaticamente.
2. **Bot solo-fotos** — en los canales que le indiques borra todo lo que no sea una
   fotografia (texto suelto, archivos que no son imagenes y, si quieres, tambien las
   fotos que vengan con texto).

## Niveles VIP

| Nivel | Precio | Roles que otorga |
|-------|--------|------------------|
| Tier 1 | $50 | Tier 1 |
| Tier 2 | $100 | Tier 1 + Tier 2 |
| Tier 3 | $200 | Tier 1 + Tier 2 + Tier 3 |

Los niveles son **acumulativos**: el tier 3 da los tres roles, el tier 2 da dos y el
tier 1 da uno. Los precios se cambian en el `.env` (`TIER_1_PRICE`, etc.).

## Como funciona el cobro

```
/vip comprar tier:2
   -> el bot crea la orden y responde en privado:
      "Envia $100.00 por Zelle a pagos@tudominio.com
       y escribe VIP-7K3QDM en la nota"

El comprador paga por Zelle con ese codigo en el memo
   -> el banco manda el correo "Fulano sent you $100.00 with Zelle"
   -> el bot revisa el buzon cada 60s, encuentra VIP-7K3QDM,
      comprueba el monto y entrega los roles Tier 1 y Tier 2
   -> le avisa por DM y deja el registro en el canal de logs
```

Zelle **no tiene API publica**, asi que la deteccion se hace leyendo por IMAP el
correo de aviso que manda tu banco. Si prefieres no conectar el correo, pon
`IMAP_ENABLED=false` y confirma los pagos a mano con `/vip-admin confirmar`.

### Reglas de seguridad que aplica el bot

- Solo se leen correos de los remitentes de `IMAP_ALLOWED_SENDERS` (los del banco).
  Sin esa lista, cualquiera que te escriba un correo con el texto correcto podria
  activar un pago falso: **configurala siempre**.
- El monto tiene que cubrir el precio del nivel (`AMOUNT_TOLERANCE` permite un margen).
- Cada correo se procesa una sola vez y cada orden se paga una sola vez.
- Los codigos vencen a las `ORDER_TTL_HOURS` horas.
- Si alguien paga de mas, recibe el nivel mas alto que cubra el monto
  (`UPGRADE_ON_OVERPAY=false` lo desactiva).

## Instalacion

```bash
cd discord-bot
npm install
cp .env.example .env      # y rellenar
npm start                 # arranca los dos bots
```

Tambien puedes arrancarlos por separado: `npm run start:vip` / `npm run start:photo`.

### 1. Crear las aplicaciones en Discord

En https://discord.com/developers/applications crea **dos** aplicaciones (una por bot)
y en la pestana *Bot* copia el token de cada una:

- Bot VIP → `VIP_BOT_TOKEN`, y el *Application ID* → `VIP_CLIENT_ID`.
  Activa el intent **Server Members Intent** (lo necesita para asignar roles).
- Bot fotos → `PHOTO_BOT_TOKEN`. Activa el intent **Message Content Intent**
  (sin el no puede ver si el mensaje trae texto).

Invitalos al servidor con el scope `bot applications.commands` y los permisos:

- Bot VIP: *Manage Roles*, *Send Messages*, *Use Application Commands*.
- Bot fotos: *Manage Messages*, *Read Message History*, *Send Messages*.

**Importante:** en *Configuracion del servidor → Roles*, arrastra el rol del bot VIP
**por encima** de los tres roles VIP, o Discord no le dejara asignarlos. El bot avisa
en consola al arrancar si detecta este problema.

### 2. Copiar IDs

Activa *Ajustes de usuario → Avanzado → Modo desarrollador* y usa click derecho →
*Copiar ID* sobre el servidor, los roles y los canales.

### 3. Conectar el correo del banco

Con Gmail: activa la verificacion en dos pasos y crea una
[contrasena de aplicacion](https://myaccount.google.com/apppasswords); esa es la que va
en `IMAP_PASSWORD` (nunca la contrasena normal de la cuenta).

Pon en `IMAP_ALLOWED_SENDERS` la direccion desde la que tu banco manda los avisos de
Zelle (mira un correo real y copia el remitente). Ejemplos comunes:

```
IMAP_ALLOWED_SENDERS=alerts@notify.wellsfargo.com,no.reply.alerts@chase.com,email.zellepay.com
```

Si tu banco escribe el aviso con otras palabras, ajusta los patrones de
`src/payments/parseZelle.js` (`RECEIVED_PATTERNS`) y anade un caso en
`test/parseZelle.test.js` con el texto real del correo.

## Comandos

**Para todos**

| Comando | Que hace |
|---------|----------|
| `/vip precios` | Muestra los tres niveles y que incluye cada uno |
| `/vip comprar tier:<1-3>` | Genera el codigo y las instrucciones de pago |
| `/vip estado` | Muestra tus ordenes y su estado |
| `/vip cancelar [codigo]` | Cancela una orden pendiente tuya |

**Para staff** (requiere el permiso *Gestionar roles* o un rol de `VIP_ADMIN_ROLE_IDS`)

| Comando | Que hace |
|---------|----------|
| `/vip-admin confirmar codigo:<> [monto] [nota]` | Aplica un pago a mano y entrega los roles |
| `/vip-admin buscar codigo:<>` | Ficha completa de una orden |
| `/vip-admin pendientes` | Ordenes pendientes de pago |
| `/vip-admin cancelar codigo:<>` | Cancela la orden de cualquiera |
| `/vip-admin sincronizar` | Revisa el correo ahora mismo sin esperar al ciclo |

## Canal de solo fotos

Pon los IDs de canal en `PHOTO_ONLY_CHANNEL_IDS` (separados por coma). Todo mensaje
que no cumpla se borra y el bot deja un aviso que se autodestruye a los
`PHOTO_ONLY_WARN_SECONDS` segundos.

| Variable | Por defecto | Efecto |
|----------|-------------|--------|
| `PHOTO_ONLY_ALLOW_CAPTIONS` | `false` | En `false`, ni siquiera se permite texto junto a la foto |
| `PHOTO_ONLY_ALLOW_VIDEOS` | `false` | Permitir tambien videos |
| `PHOTO_ONLY_ALLOW_LINKS` | `false` | Permitir enlaces a imagenes sin adjunto |
| `PHOTO_ONLY_BYPASS_ROLE_IDS` | vacio | Roles que si pueden escribir (moderadores) |
| `PHOTO_ONLY_LOG_CHANNEL_ID` | vacio | Canal donde registrar lo borrado |

Tambien vigila las **ediciones**: si alguien sube una foto valida y luego le agrega
texto, el mensaje se borra igual.

## Estructura

```
src/
  config.js              lectura y validacion del .env
  index.js               arranca los dos bots
  deployCommands.js      registra los comandos slash sin arrancar el bot
  bots/vipBot.js         cliente del bot VIP
  bots/photoBot.js       cliente del bot de solo-fotos
  lib/codes.js           generacion y deteccion de los codigos aleatorios
  lib/tiers.js           precios y regla acumulativa de niveles
  lib/store.js           persistencia JSON (data/store.json)
  payments/parseZelle.js lectura del correo del banco
  payments/zelleWatcher.js  revision periodica del buzon por IMAP
  vip/orders.js          ciclo de vida de las ordenes
  vip/roles.js           asignacion de roles
  vip/paymentFlow.js     pago -> orden -> roles -> avisos
  vip/commands.js        comandos slash
  photo/photoOnly.js     regla de que se permite en el canal de fotos
test/                    pruebas (node --test)
```

Los datos viven en `data/store.json` (ordenes, pagos y correos ya procesados).
Ese archivo esta en `.gitignore`: **haz respaldo** si te importa el historial.

## Pruebas

```bash
npm test
```

Cubren la generacion y deteccion de codigos, la regla acumulativa de niveles, el
analisis de los correos de Zelle (incluidos los intentos de suplantacion y los pagos
enviados), el ciclo de vida de las ordenes y el flujo completo de pago con un cliente
de Discord simulado.
