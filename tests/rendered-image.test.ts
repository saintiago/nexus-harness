import { describe, expect, it } from 'vitest';
import { renderedImageProblem } from '../src/task-engine/actions/preparation/rendered-image.js';

/** Complete one-pixel images, retained independently of the decoder under test. */
const images = {
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  jpeg: '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z',
  gif: 'R0lGODlhAQABAIAAAExpcf8AACH5BAUAAAAALAAAAAABAAEAAAICTAEAOw==',
  webp: 'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=',
};

describe('readable rendered-image evidence', () => {
  it.each(Object.entries(images))('fully decodes a complete %s image', async (_format, base64) => {
    await expect(renderedImageProblem(Buffer.from(base64, 'base64'))).resolves.toBeNull();
  });

  it('rejects a JPEG frame and end marker with no scan data', async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 9, 8, 0, 1, 0, 1, 0xff, 0xd9]);
    await expect(renderedImageProblem(bytes)).resolves.toMatch(/not decodable/);
  });

  it('rejects a WebP extended header without pixel data', async () => {
    const bytes = Buffer.alloc(30);
    bytes.write('RIFF');
    bytes.writeUInt32LE(22, 4);
    bytes.write('WEBPVP8X', 8);
    bytes.writeUInt32LE(10, 16);
    await expect(renderedImageProblem(bytes)).resolves.toMatch(/not decodable/);
  });

  it.each(['IHDR', 'IDAT', 'IEND'])(
    'rejects a PNG with corrupt %s CRC and intact pixels',
    async (chunk) => {
      const bytes = Buffer.from(images.png, 'base64');
      const start = bytes.indexOf(chunk);
      const length = bytes.readUInt32BE(start - 4);
      bytes.fill(0, start + 4 + length, start + 8 + length);
      await expect(renderedImageProblem(bytes)).resolves.toMatch(/not decodable/);
    },
  );

  it('rejects corrupt GIF compressed pixels in a complete container', async () => {
    const bytes = Buffer.from(images.gif, 'base64');
    // The image descriptor has no local color table; corrupt its LZW minimum code size.
    const descriptor = bytes.indexOf(0x2c);
    bytes[descriptor + 10] = 12;
    await expect(renderedImageProblem(bytes)).resolves.toMatch(/not decodable/);
  });

  it('keeps unsupported formats outside the screenshot contract', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    await expect(renderedImageProblem(svg)).resolves.toMatch(/not PNG, JPEG, GIF or WebP/);
  });
});
