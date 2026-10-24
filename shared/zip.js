// Lottie Scraper — tiny ZIP writer/reader built on the native Compression Streams API.
(function (root) {
  'use strict';

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  async function pipe(bytes, transform) {
    const stream = new Blob([bytes]).stream().pipeThrough(transform);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const deflateRaw = (b) => pipe(b, new CompressionStream('deflate-raw'));
  const inflateRaw = (b) => pipe(b, new DecompressionStream('deflate-raw'));

  const enc = new TextEncoder();
  const toBytes = (d) => (typeof d === 'string' ? enc.encode(d) : d instanceof Uint8Array ? d : new Uint8Array(d));

  function dosDateTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }

  class ZipWriter {
    constructor() {
      this.parts = [];
      this.central = [];
      this.offset = 0;
      this.count = 0;
    }

    async add(name, data, { compress = true, date = new Date() } = {}) {
      const raw = toBytes(data);
      const nameBytes = enc.encode(name);
      const crc = crc32(raw);
      let body = raw, method = 0;
      if (compress && raw.length > 64) {
        const z = await deflateRaw(raw);
        if (z.length < raw.length) { body = z; method = 8; }
      }
      const { time, date: dd } = dosDateTime(date);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint16(8, method, true);
      local.setUint16(10, time, true);
      local.setUint16(12, dd, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, body.length, true);
      local.setUint32(22, raw.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);

      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, method, true);
      cen.setUint16(12, time, true);
      cen.setUint16(14, dd, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, body.length, true);
      cen.setUint32(24, raw.length, true);
      cen.setUint16(28, nameBytes.length, true);
      cen.setUint32(42, this.offset, true);

      this.parts.push(new Uint8Array(local.buffer), nameBytes, body);
      this.central.push(new Uint8Array(cen.buffer), nameBytes);
      this.offset += 30 + nameBytes.length + body.length;
      this.count++;
    }

    finish() {
      const cdSize = this.central.reduce((s, p) => s + p.length, 0);
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true);
      end.setUint16(8, this.count, true);
      end.setUint16(10, this.count, true);
      end.setUint32(12, cdSize, true);
      end.setUint32(16, this.offset, true);
      return new Blob([...this.parts, ...this.central, new Uint8Array(end.buffer)], { type: 'application/zip' });
    }
  }

  // Returns [{name, size, read(): Promise<Uint8Array>}]
  function readZip(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a zip archive');
    const total = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const entries = [];
    for (let n = 0; n < total; n++) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      const method = view.getUint16(p + 10, true);
      const csize = view.getUint32(p + 20, true);
      const size = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localOffset = view.getUint32(p + 42, true);
      const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      entries.push({
        name,
        size,
        async read() {
          const ln = view.getUint16(localOffset + 26, true);
          const le = view.getUint16(localOffset + 28, true);
          const start = localOffset + 30 + ln + le;
          const data = bytes.subarray(start, start + csize);
          if (method === 0) return data;
          if (method === 8) return inflateRaw(data);
          throw new Error('Unsupported zip compression method ' + method);
        }
      });
    }
    return entries;
  }

  const api = { ZipWriter, readZip, crc32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LottieZip = api;
})(typeof self !== 'undefined' ? self : globalThis);
