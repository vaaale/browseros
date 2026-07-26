import "server-only";
import { deflateRawSync, crc32 } from "zlib";

// Minimal in-memory ZIP writer (no external dependency — Node's built-in zlib
// covers both DEFLATE and CRC-32). Only the small subset of the ZIP spec
// (PKWARE APPNOTE.TXT) needed for "download this folder" is implemented: one
// local file header + payload per entry, then a central directory, then the
// end-of-central-directory record. No ZIP64, no encryption, no streaming.

export interface ZipEntryInput {
  /** Archive-relative path using forward slashes. Directory entries end with "/" and omit `data`. */
  name: string;
  data?: Buffer;
  /** Epoch milliseconds; defaults to now. */
  modified?: number;
}

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;
const DIR_EXTERNAL_ATTRS = 0x10 << 16; // MS-DOS directory attribute, shifted into the Unix high word slot

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  const dosDate = (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  const dosTime = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  return { time: dosTime, date: dosDate };
}

/** Build a ZIP archive (DEFLATE, falling back to STORE when that doesn't shrink the data) entirely in memory. */
export function createZip(entries: ZipEntryInput[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const isDir = entry.data === undefined;
    const nameBuf = Buffer.from(entry.name, "utf8");
    const data = entry.data ?? Buffer.alloc(0);
    const deflated = isDir ? data : deflateRawSync(data);
    const store = isDir || deflated.length >= data.length;
    const method = store ? 0 : 8;
    const payload = store ? data : deflated;
    const crc = isDir ? 0 : (crc32(data) >>> 0);
    const { time, date } = dosDateTime(new Date(entry.modified ?? Date.now()));

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIG, 0);
    localHeader.writeUInt16LE(20, 4); // version needed to extract
    localHeader.writeUInt16LE(0, 6); // general purpose flag
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    localChunks.push(localHeader, nameBuf, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_DIR_SIG, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(0, 8); // general purpose flag
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // file comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(isDir ? DIR_EXTERNAL_ATTRS : 0, 38); // external file attributes
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header
    centralChunks.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralDirOffset = offset;
  const centralDir = Buffer.concat(centralChunks);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIR_SIG, 0);
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central directory start
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(centralDirOffset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localChunks, centralDir, end]);
}
