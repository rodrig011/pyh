import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMessage, isImageAttachment } from '../src/photo/photoOnly.js';

const foto = { contentType: 'image/png', name: 'foto.png' };

test('reconoce imagenes por tipo y por extension', () => {
  assert.equal(isImageAttachment(foto), true);
  assert.equal(isImageAttachment({ name: 'foto.JPG' }), true);
  assert.equal(isImageAttachment({ name: 'documento.pdf' }), false);
  assert.equal(isImageAttachment({}), false);
});

test('una foto sola se permite', () => {
  assert.equal(evaluateMessage({ attachments: [foto] }).allowed, true);
});

test('el texto solo se borra', () => {
  const verdict = evaluateMessage({ content: 'hola a todos' });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'sin_imagen');
});

test('un mensaje vacio sin adjuntos se borra', () => {
  assert.equal(evaluateMessage({ content: '   ' }).allowed, false);
});

test('foto con texto se borra por defecto y se permite con captions', () => {
  const message = { content: 'miren esto', attachments: [foto] };
  const estricto = evaluateMessage(message);
  assert.equal(estricto.allowed, false);
  assert.equal(estricto.reason, 'texto_no_permitido');
  assert.equal(evaluateMessage(message, { allowCaptions: true }).allowed, true);
});

test('un archivo que no es imagen se borra', () => {
  const verdict = evaluateMessage({ attachments: [{ contentType: 'application/pdf', name: 'x.pdf' }] });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'adjunto_no_es_imagen');
});

test('los videos solo pasan si se habilitan', () => {
  const message = { attachments: [{ contentType: 'video/mp4', name: 'clip.mp4' }] };
  assert.equal(evaluateMessage(message).allowed, false);
  assert.equal(evaluateMessage(message, { allowVideos: true }).allowed, true);
});

test('los enlaces a imagenes solo pasan si se habilitan', () => {
  const message = { content: 'https://ejemplo.com/foto.png', embeds: [{ type: 'image' }] };
  assert.equal(evaluateMessage(message).allowed, false);
  assert.equal(evaluateMessage(message, { allowLinks: true, allowCaptions: true }).allowed, true);
});

test('los bots y los mensajes del sistema se ignoran', () => {
  assert.equal(evaluateMessage({ authorIsBot: true, content: 'aviso' }).allowed, true);
  assert.equal(evaluateMessage({ authorIsBot: true, content: 'aviso' }, { ignoreBots: false }).allowed, false);
  assert.equal(evaluateMessage({ isSystem: true, content: 'se unio al servidor' }).allowed, true);
});

test('los roles exentos pueden escribir texto', () => {
  const message = { content: 'moderando', memberRoleIds: ['mod'] };
  assert.equal(evaluateMessage(message).allowed, false);
  assert.equal(evaluateMessage(message, { bypassRoleIds: ['mod'] }).allowed, true);
  assert.equal(evaluateMessage(message, { bypassRoleIds: ['otro'] }).allowed, false);
});
