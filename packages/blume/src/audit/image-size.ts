/**
 * Pixel dimensions read straight from a PNG, JPEG, or GIF header. A dedicated
 * image library would be a dependency for three well-documented byte layouts;
 * anything else (SVG, WebP, AVIF) yields null and its checks simply don't run.
 */
export interface ImageSize {
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const pngSize = (bytes: Buffer): ImageSize | null => {
  // Signature, then the IHDR chunk is required to come first: width and height
  // are big-endian u32s at fixed offsets 16 and 20.
  if (bytes.length < 24 || !bytes.subarray(0, 4).equals(PNG_SIGNATURE)) {
    return null;
  }
  return { height: bytes.readUInt32BE(20), width: bytes.readUInt32BE(16) };
};

/** JPEG start-of-frame markers (C0–CF minus DHT C4, JPG C8, DAC CC). */
const isSof = (marker: number): boolean =>
  marker >= 0xc0 &&
  marker <= 0xcf &&
  marker !== 0xc4 &&
  marker !== 0xc8 &&
  marker !== 0xcc;

const jpegSize = (bytes: Buffer): ImageSize | null => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  // Walk the segment list: each is FF <marker> <u16 length> <payload>. The
  // dimensions live in the first start-of-frame segment's payload, as
  // big-endian u16s after a one-byte precision field.
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return null;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (isSof(marker)) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return null;
};

const gifSize = (bytes: Buffer): ImageSize | null => {
  if (bytes.length < 10 || bytes.subarray(0, 4).toString("latin1") !== "GIF8") {
    return null;
  }
  return { height: bytes.readUInt16LE(8), width: bytes.readUInt16LE(6) };
};

/** The image's pixel dimensions, or null when the format isn't recognized. */
export const imageSize = (bytes: Buffer): ImageSize | null =>
  pngSize(bytes) ?? jpegSize(bytes) ?? gifSize(bytes);
