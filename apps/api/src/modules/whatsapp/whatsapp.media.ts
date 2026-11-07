import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { WhatsAppError } from './whatsapp.types';

export interface WhatsAppUpload {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}
const formats: Record<string, { mime: string; kind: 'document' | 'audio' }> = {
  '.pdf': { mime: 'application/pdf', kind: 'document' },
  '.txt': { mime: 'text/plain', kind: 'document' },
  '.doc': { mime: 'application/msword', kind: 'document' },
  '.docx': {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    kind: 'document',
  },
  '.xls': { mime: 'application/vnd.ms-excel', kind: 'document' },
  '.xlsx': {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    kind: 'document',
  },
  '.ppt': { mime: 'application/vnd.ms-powerpoint', kind: 'document' },
  '.pptx': {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    kind: 'document',
  },
  '.aac': { mime: 'audio/aac', kind: 'audio' },
  '.amr': { mime: 'audio/amr', kind: 'audio' },
  '.mp3': { mime: 'audio/mpeg', kind: 'audio' },
  '.m4a': { mime: 'audio/mp4', kind: 'audio' },
  '.ogg': { mime: 'audio/ogg', kind: 'audio' },
};

// Inspect bytes as well as the extension/MIME supplied by the browser.
// Ogg must contain a mono Opus identification header; arbitrary archives are rejected.
function matches(bytes: Buffer, ext: string): boolean {
  if (ext === '.pdf') return bytes.subarray(0, 5).toString() === '%PDF-';
  if (ext === '.txt') {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return !Array.from(text).some((c) => {
        const n = c.charCodeAt(0);
        return n < 32 && ![9, 10, 13].includes(n);
      });
    } catch {
      return false;
    }
  }
  if (['.doc', '.xls', '.ppt'].includes(ext))
    return bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
  if (['.docx', '.xlsx', '.pptx'].includes(ext)) {
    if (!bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex')))
      return false;
    const folder = ext === '.docx' ? 'word/' : ext === '.xlsx' ? 'xl/' : 'ppt/';
    return (
      bytes.includes(Buffer.from('[Content_Types].xml')) &&
      bytes.includes(Buffer.from(folder))
    );
  }
  if (ext === '.amr') return bytes.subarray(0, 6).toString() === '#!AMR\n';
  if (ext === '.m4a')
    return bytes.length > 12 && bytes.subarray(4, 8).toString() === 'ftyp';
  if (ext === '.ogg') {
    const head = bytes.subarray(0, 4096),
      at = head.indexOf('OpusHead');
    return (
      head.subarray(0, 4).toString() === 'OggS' &&
      at >= 0 &&
      at + 9 < head.length &&
      head[at + 9] === 1
    );
  }
  if (ext === '.aac')
    return bytes.length > 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
  if (ext === '.mp3')
    return (
      bytes.subarray(0, 3).toString() === 'ID3' ||
      (bytes.length > 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
    );
  return false;
}
export function validateWhatsAppUpload(
  file: WhatsAppUpload | undefined,
  kind: 'document' | 'audio',
) {
  if (!file || !Buffer.isBuffer(file.buffer))
    throw new WhatsAppError('WHATSAPP_MEDIA_REQUIRED');
  const ext = extname(file.originalname).toLowerCase(),
    format = formats[ext];
  const mime = file.mimetype.split(';')[0].trim().toLowerCase();
  const limit = kind === 'audio' ? 16_000_000 : 20_000_000;
  if (
    !format ||
    format.kind !== kind ||
    file.size !== file.buffer.length ||
    file.size < 1 ||
    file.size > limit ||
    (mime && mime !== 'application/octet-stream' && mime !== format.mime) ||
    !matches(file.buffer, ext)
  )
    throw new WhatsAppError('WHATSAPP_MEDIA_UNSUPPORTED');
  // Multipart clients can send UTF-8 filename bytes decoded as Latin-1 by Busboy.
  // Restore only a lossless UTF-8 round trip; keep an already-correct Unicode name.
  const decoded = Buffer.from(file.originalname, 'latin1').toString('utf8');
  const originalName =
    !decoded.includes('\ufffd') &&
    Buffer.from(decoded, 'utf8').toString('latin1') === file.originalname
      ? decoded
      : file.originalname;
  // Preserve the extension if a long filename is truncated.
  const base =
    originalName
      .replace(/.*[/\\]/, '')
      .slice(0, -ext.length)
      .replace(/[^\p{L}\p{N}_. -]/gu, '_')
      .slice(0, 120) || 'whatsapp';
  return {
    kind,
    mime: format.mime,
    name: base + ext,
    size: file.size,
    sha256: createHash('sha256').update(file.buffer).digest('hex'),
  };
}
