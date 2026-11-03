const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/** Bytes needed by `matchesImageSignature`. */
export const SNIFF_BYTES = 512;

/** Magic-byte check for declared image types. Unknown image/* subtypes are rejected (strict allowlist). */
export function matchesImageSignature(contentType: string, head: Uint8Array): boolean {
  switch (contentType) {
    case 'image/png':
      return head[0] === 0x89 && ascii(head, 1, 4) === 'PNG';
    case 'image/jpeg':
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'image/gif':
      return ['GIF87a', 'GIF89a'].includes(ascii(head, 0, 6));
    case 'image/webp':
      return ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP';
    case 'image/bmp':
      return ascii(head, 0, 2) === 'BM';
    case 'image/avif':
      return ascii(head, 4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(head, 8, 12));
    case 'image/x-icon':
    case 'image/vnd.microsoft.icon':
      return head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0;
    case 'image/svg+xml': {
      const text = new TextDecoder().decode(head).trimStart().toLowerCase();
      return text.startsWith('<svg') || ((text.startsWith('<?xml') || text.startsWith('<!--')) && text.includes('<svg'));
    }
    default:
      return false;
  }
}
