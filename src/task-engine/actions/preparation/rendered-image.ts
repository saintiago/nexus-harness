import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { messageOf } from '../../../result.js';

/**
 * Require complete PNG chunks with valid CRCs through IEND. The pixel decoder may finish reading
 * all rows before checking the container's tail, overlooking truncation or corruption there.
 */
function completePng(bytes: Buffer): boolean {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > bytes.length) return false;
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) {
      return false;
    }
    if (bytes.toString('latin1', offset + 4, offset + 8) === 'IEND') {
      return length === 0;
    }
    offset = end;
  }
  return false;
}

/**
 * Why the saved bytes are not readable rendered-image evidence, or null when they fully decode
 * as PNG, JPEG, GIF or WebP. Metadata alone cannot establish readable pixels. Strict decoding
 * rejects truncated data and decoder warnings such as corrupt PNG chunk CRCs; animated inputs
 * must decode all frames.
 */
export async function renderedImageProblem(bytes: Buffer): Promise<string | null> {
  try {
    const image = sharp(bytes, { failOn: 'warning', animated: true });
    const { format } = await image.metadata();
    if (format === undefined || !['png', 'jpeg', 'gif', 'webp'].includes(format)) {
      return 'it is not PNG, JPEG, GIF or WebP image data';
    }
    if (format === 'png' && !completePng(bytes)) {
      return 'its image data is not decodable: incomplete or corrupt PNG container';
    }
    await image.raw().toBuffer();
    return null;
  } catch (error) {
    return `its image data is not decodable: ${messageOf(error)}`;
  }
}
