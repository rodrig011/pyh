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
 * Decides whether a message may stay in a photos-only channel.
 * Pure function, so it can be tested without Discord.
 *
 * @param {object} message
 * @param {boolean} [message.authorIsBot]
 * @param {string} [message.content]
 * @param {Array<{contentType?: string, name?: string}>} [message.attachments]
 * @param {Array<{type?: string, image?: object, thumbnail?: object}>} [message.embeds]
 * @param {string[]} [message.memberRoleIds]
 * @param {string} [message.authorId]
 * @param {boolean} [message.isSystem]
 * @param {object} options
 * @param {boolean} [options.allowCaptions=false] allow text alongside the photo
 * @param {boolean} [options.allowVideos=false]
 * @param {boolean} [options.allowLinks=false] allow image links without an attachment
 * @param {boolean} [options.ignoreBots=true]
 * @param {string[]} [options.bypassRoleIds=[]]
 * @param {string[]} [options.bypassUserIds=[]] named people, whatever roles they hold
 * @returns {{allowed: boolean, reason: string}}
 */
export function evaluateMessage(message = {}, options = {}) {
  const {
    allowCaptions = false,
    allowVideos = false,
    allowLinks = false,
    ignoreBots = true,
    bypassRoleIds = [],
    bypassUserIds = [],
  } = options;

  if (message.isSystem) return { allowed: true, reason: 'system message' };
  if (ignoreBots && message.authorIsBot) return { allowed: true, reason: 'bot message' };

  // One person, by name. A role is the wrong tool for "let Kenson post text":
  // it either exists only for this and clutters the role list, or it is a real
  // role and everybody who has it gets the exemption too.
  if (message.authorId && bypassUserIds.includes(message.authorId)) {
    return { allowed: true, reason: 'bypass user' };
  }

  const roles = message.memberRoleIds ?? [];
  if (bypassRoleIds.length > 0 && roles.some((roleId) => bypassRoleIds.includes(roleId))) {
    return { allowed: true, reason: 'bypass role' };
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
      return { allowed: false, reason: 'attachment_not_an_image' };
    }
    return { allowed: false, reason: 'no_image' };
  }

  if (!allowCaptions && content !== '') {
    return { allowed: false, reason: 'text_not_allowed' };
  }

  return { allowed: true, reason: 'ok' };
}

export const REASON_MESSAGES = {
  no_image: 'This channel is for **photos only**. Your message was removed because it had no image.',
  attachment_not_an_image:
    'This channel only accepts **images**. The file you uploaded is not a photo, so it was removed.',
  text_not_allowed:
    'This channel only accepts **photos with no text**. Post the image again, but without writing anything in the message.',
};
