import { inflateSync } from 'node:zlib';

/**
 * The rendered-image evidence check for saved prototype screenshots: a record must carry decodable
 * image data of one supported format, not merely the byte signature that a truncated or corrupt
 * file can also carry. PNG is validated down to its decompressed pixel data; JPEG, GIF and WebP
 * are validated as complete, well-formed containers with nonempty declared dimensions.
 */

/** The PNG color types and their channel counts, as the format defines them. */
const pngChannels: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** The PNG bit depths the format defines. */
const pngBitDepths = new Set([1, 2, 4, 8, 16]);

/** True when the saved bytes open a PNG image. */
function pngSignature(bytes: Buffer): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

/** Why the bytes are not a complete, decodable PNG image, or null when they are. */
function pngProblem(bytes: Buffer): string | null {
  let offset = 8;
  let header: {
    readonly height: number;
    readonly rowBytes: number;
    readonly interlace: number;
  } | null = null;
  const imageData: Buffer[] = [];
  while (true) {
    if (offset + 12 > bytes.length) {
      return 'it is truncated before a PNG chunk completes';
    }
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('latin1');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      return 'it is truncated before a PNG chunk completes';
    }
    const data = bytes.subarray(dataStart, dataEnd);
    if (header === null) {
      if (type !== 'IHDR' || length !== 13) {
        return 'it does not begin with a PNG image header';
      }
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const channels = pngChannels[data[9] ?? -1];
      const interlace = data[12];
      if (
        width === 0 ||
        height === 0 ||
        bitDepth === undefined ||
        !pngBitDepths.has(bitDepth) ||
        channels === undefined ||
        interlace === undefined
      ) {
        return 'it declares an empty or unsupported PNG image';
      }
      header = {
        height,
        rowBytes: 1 + Math.ceil((width * channels * bitDepth) / 8),
        interlace,
      };
    } else if (type === 'IDAT') {
      imageData.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }
  if (imageData.length === 0) {
    return 'it carries no PNG image data';
  }
  let decoded: Buffer;
  try {
    decoded = inflateSync(Buffer.concat(imageData));
  } catch {
    return 'its PNG image data is not decodable';
  }
  if (header.interlace === 0 && decoded.length !== header.height * header.rowBytes) {
    return 'it carries incomplete PNG image data';
  }
  return null;
}

/** True when the saved bytes open a JPEG image. */
function jpegSignature(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** Why the bytes are not a complete, well-formed JPEG image, or null when they are. */
function jpegProblem(bytes: Buffer): string | null {
  let offset = 2;
  let frame = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return 'it is malformed JPEG image data';
    }
    while (bytes[offset] === 0xff) {
      offset += 1;
    }
    const marker = bytes[offset];
    if (marker === undefined) {
      break;
    }
    offset += 1;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (marker === 0xd9) {
      return frame ? null : 'it carries no JPEG image frame';
    }
    if (offset + 2 > bytes.length) {
      return 'it is truncated before a JPEG segment completes';
    }
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) {
      return 'it is truncated before a JPEG segment completes';
    }
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 7) {
        return 'it has an incomplete JPEG image frame';
      }
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (width === 0 || height === 0) {
        return 'it declares an empty JPEG image';
      }
      frame = true;
    }
    if (marker === 0xda) {
      // The entropy-coded scan runs to the end-of-image marker; a screenshot cut inside its image
      // data therefore lacks the final marker.
      return frame && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
        ? null
        : 'it is truncated inside its JPEG image data';
    }
    offset += length;
  }
  return 'it is truncated before a JPEG segment completes';
}

/** True when the saved bytes open a GIF image. */
function gifSignature(bytes: Buffer): boolean {
  const header = bytes.length >= 6 ? bytes.subarray(0, 6).toString('latin1') : '';
  return header === 'GIF87a' || header === 'GIF89a';
}

/** The offset after one GIF sub-block sequence, or null when it is truncated. */
function skipGifSubBlocks(bytes: Buffer, start: number): number | null {
  let offset = start;
  while (offset < bytes.length) {
    const size = bytes[offset];
    offset += 1;
    if (size === undefined) {
      return null;
    }
    if (size === 0) {
      return offset;
    }
    offset += size;
  }
  return null;
}

/** Why the bytes are not a complete, well-formed GIF image, or null when they are. */
function gifProblem(bytes: Buffer): string | null {
  if (bytes.length < 13) {
    return 'it is truncated before its GIF screen descriptor';
  }
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  if (width === 0 || height === 0) {
    return 'it declares an empty GIF image';
  }
  const packed = bytes[10] ?? 0;
  let offset = 13;
  if ((packed & 0x80) !== 0) {
    offset += 3 * 2 ** ((packed & 0x07) + 1);
  }
  let image = false;
  while (true) {
    if (offset >= bytes.length) {
      return 'it is truncated before its GIF end marker';
    }
    const block = bytes[offset];
    if (block === 0x3b) {
      return image ? null : 'it carries no GIF image data';
    }
    if (block === 0x2c) {
      if (offset + 10 > bytes.length) {
        return 'it is truncated before its GIF image descriptor completes';
      }
      const imagePacked = bytes[offset + 9] ?? 0;
      offset += 10;
      if ((imagePacked & 0x80) !== 0) {
        offset += 3 * 2 ** ((imagePacked & 0x07) + 1);
      }
      const next = skipGifSubBlocks(bytes, offset + 1);
      if (next === null) {
        return 'it is truncated inside its GIF image data';
      }
      offset = next;
      image = true;
      continue;
    }
    if (block === 0x21) {
      const next = skipGifSubBlocks(bytes, offset + 2);
      if (next === null) {
        return 'it is truncated inside a GIF extension block';
      }
      offset = next;
      continue;
    }
    return 'it contains malformed GIF block data';
  }
}

/** True when the saved bytes open a WebP image. */
function webpSignature(bytes: Buffer): boolean {
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  );
}

/** Why the bytes are not a complete, decodable WebP image, or null when they are. */
function webpProblem(bytes: Buffer): string | null {
  const declared = bytes.readUInt32LE(4) + 8;
  if (declared !== bytes.length - (bytes.length % 2 === 0 ? 0 : 1) && declared !== bytes.length) {
    return 'its declared file size does not match the saved bytes';
  }
  let offset = 12;
  let image = false;
  while (offset + 8 <= bytes.length) {
    const fourCc = bytes.subarray(offset, offset + 4).toString('latin1');
    const size = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) {
      return 'it is truncated before a WebP chunk completes';
    }
    const data = bytes.subarray(dataStart, dataEnd);
    if (fourCc === 'VP8 ' && size >= 10) {
      if (data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) {
        return 'its WebP image header is malformed';
      }
      const width = ((data[6] ?? 0) | ((data[7] ?? 0) << 8)) & 0x3fff;
      const height = ((data[8] ?? 0) | ((data[9] ?? 0) << 8)) & 0x3fff;
      if (width === 0 || height === 0) {
        return 'it declares an empty WebP image';
      }
      image = true;
    } else if (fourCc === 'VP8L' && size >= 5) {
      if (data[0] !== 0x2f) {
        return 'its WebP lossless header is malformed';
      }
      image = true;
    } else if (fourCc === 'VP8X' && size >= 10) {
      image = true;
    }
    offset = dataEnd + (size % 2);
  }
  return image ? null : 'it carries no WebP image data';
}

/** One accepted image format with its signature and decodability check. */
const formats: readonly {
  readonly matches: (bytes: Buffer) => boolean;
  readonly problem: (bytes: Buffer) => string | null;
}[] = [
  { matches: pngSignature, problem: pngProblem },
  { matches: jpegSignature, problem: jpegProblem },
  { matches: gifSignature, problem: gifProblem },
  { matches: webpSignature, problem: webpProblem },
];

/**
 * Why the saved bytes are not readable rendered-image evidence, or null when they carry decodable
 * image data of one supported format. A signature alone, a truncated file or corrupt image data
 * cannot satisfy the observation contract.
 */
export function renderedImageProblem(bytes: Buffer): string | null {
  const format = formats.find((candidate) => candidate.matches(bytes));
  if (format === undefined) {
    return 'it is not PNG, JPEG, GIF or WebP image data';
  }
  return format.problem(bytes);
}
