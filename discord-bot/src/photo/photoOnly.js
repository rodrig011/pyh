const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif', 'tiff'];
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm', 'mkv', 'avi'];

function extensionOf(name = '') {
  const match = /\.([a-z0-9]+)$/i.exec(name.trim());
  return match ? match[1].toLowerCase() : '';
}

export function isImageAttachment(attachment = {}) {
  const type = (attachment.contentType ?? '').toLowerCase();
  if (type.startsWith('image/')) return true;
  return IMAGE_EXTENSIONS.includes(extensionOf(attachment.name ?? ''));
}

export function isVideoAttachment(attachment = {}) {
  const type = (attachment.contentType ?? '').toLowerCase();
  if (type.startsWith('video/')) return true;
  return VIDEO_EXTENSIONS.includes(extensionOf(attachment.name ?? ''));
}

/**
 * Decide si un mensaje puede quedarse en un canal de solo-fotos.
 * Es una funcion pura para poder probarla sin Discord.
 *
 * @param {object} message
 * @param {boolean} [message.authorIsBot]
 * @param {string} [message.content]
 * @param {Array<{contentType?: string, name?: string}>} [message.attachments]
 * @param {Array<{type?: string, image?: object, thumbnail?: object}>} [message.embeds]
 * @param {string[]} [message.memberRoleIds]
 * @param {boolean} [message.isSystem]
 * @param {object} options
 * @param {boolean} [options.allowCaptions=false] permitir texto junto a la foto
 * @param {boolean} [options.allowVideos=false]
 * @param {boolean} [options.allowLinks=false] permitir enlaces a imagenes sin adjunto
 * @param {boolean} [options.ignoreBots=true]
 * @param {string[]} [options.bypassRoleIds=[]]
 * @returns {{allowed: boolean, reason: string}}
 */
export function evaluateMessage(message = {}, options = {}) {
  const {
    allowCaptions = false,
    allowVideos = false,
    allowLinks = false,
    ignoreBots = true,
    bypassRoleIds = [],
  } = options;

  if (message.isSystem) return { allowed: true, reason: 'mensaje del sistema' };
  if (ignoreBots && message.authorIsBot) return { allowed: true, reason: 'mensaje de bot' };

  const roles = message.memberRoleIds ?? [];
  if (bypassRoleIds.length > 0 && roles.some((roleId) => bypassRoleIds.includes(roleId))) {
    return { allowed: true, reason: 'rol exento' };
  }

  const attachments = message.attachments ?? [];
  const hasImage = attachments.some(isImageAttachment);
  const hasVideo = attachments.some(isVideoAttachment);
  const embeds = message.embeds ?? [];
  const hasImageEmbed = embeds.some(
    (embed) => embed?.image || embed?.thumbnail || embed?.type === 'image' || embed?.type === 'gifv',
  );

  const content = (message.content ?? '').trim();

  let hasMedia = hasImage;
  if (!hasMedia && allowVideos && hasVideo) hasMedia = true;
  if (!hasMedia && allowLinks && hasImageEmbed) hasMedia = true;

  if (!hasMedia) {
    if (attachments.length > 0) {
      return { allowed: false, reason: 'adjunto_no_es_imagen' };
    }
    return { allowed: false, reason: 'sin_imagen' };
  }

  if (!allowCaptions && content !== '') {
    return { allowed: false, reason: 'texto_no_permitido' };
  }

  return { allowed: true, reason: 'ok' };
}

export const REASON_MESSAGES = {
  sin_imagen: 'En este canal solo se pueden publicar **fotos**. Tu mensaje fue borrado porque no traia ninguna imagen.',
  adjunto_no_es_imagen: 'En este canal solo se aceptan **imagenes**. El archivo que subiste no es una foto, asi que se borro.',
  texto_no_permitido:
    'En este canal solo se aceptan **fotos sin texto**. Vuelve a subir la imagen, pero sin escribir nada en el mensaje.',
};
