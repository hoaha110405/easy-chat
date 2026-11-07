import type { Response } from 'express';

// Single byte ranges allow the browser's audio player to seek without public file URLs.
export function sendPrivateMedia(
  res: Response,
  file: { bytes: Buffer; mime: string; name: string; inline?: boolean },
  range?: string,
) {
  const size = file.bytes.length;
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader(
    'Content-Disposition',
    `${(file.inline ?? file.mime.startsWith('audio/')) ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
  );
  let start = 0,
    end = size - 1;
  if (range) {
    const parsed = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!parsed || (!parsed[1] && !parsed[2]) || size === 0) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`);
      res.end();
      return;
    }
    start = parsed[1]
      ? Number(parsed[1])
      : Math.max(0, size - Number(parsed[2]));
    end =
      parsed[1] && parsed[2] ? Math.min(Number(parsed[2]), size - 1) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= size ||
      end < start ||
      (!parsed[1] && Number(parsed[2]) === 0)
    ) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`);
      res.end();
      return;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.setHeader('Content-Length', Math.max(0, end - start + 1));
  res.send(file.bytes.subarray(start, end + 1));
}
