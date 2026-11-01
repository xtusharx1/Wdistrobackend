// Minimal ZIP writer (stored, no compression; PDFs are already compressed). Avoids an extra dependency.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const dosDateTime = (d) => ({
  time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f),
  date: (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f),
});

// files: [{ name, data: Buffer }] -> Buffer
const createZip = (files, now = new Date()) => {
  const { time, date } = dosDateTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);       // version needed
    local.writeUInt16LE(0x0800, 6);   // UTF-8 names
    local.writeUInt16LE(0, 8);        // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);     // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
};

// Write one chunk, honouring backpressure; rejects if the client goes away so callers stop producing.
const writeChunk = (out, buf) => new Promise((resolve, reject) => {
  if (out.destroyed || out.writableEnded) return reject(new Error('client disconnected'));
  if (out.write(buf)) return resolve();
  const done = (err) => { out.off('drain', onDrain); out.off('close', onClose); out.off('error', onClose); err ? reject(err) : resolve(); };
  const onDrain = () => done();
  const onClose = () => done(new Error('client disconnected'));
  out.once('drain', onDrain); out.once('close', onClose); out.once('error', onClose);
});

// Streaming ZIP: each entry goes to `out` as soon as it is added, so memory use is one entry at a time
// plus the tiny central-directory records kept until finish(). Entries are stored (PDFs are already compressed).
const createZipStream = (out, now = new Date()) => {
  const { time, date } = dosDateTime(now);
  const centrals = [];
  let offset = 0;
  let count = 0;
  return {
    async addFile(name, data) {
      const nameBuf = Buffer.from(name, 'utf8');
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const crc = crc32(buf);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(0, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(buf.length, 18);
      local.writeUInt32LE(buf.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      await writeChunk(out, local);
      await writeChunk(out, nameBuf);
      await writeChunk(out, buf);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(time, 12);
      central.writeUInt16LE(date, 14);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(buf.length, 20);
      central.writeUInt32LE(buf.length, 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt32LE(offset, 42);
      centrals.push(central, nameBuf);
      offset += local.length + nameBuf.length + buf.length;
      count++;
    },
    async finish() {
      const centralSize = centrals.reduce((s, b) => s + b.length, 0);
      for (const c of centrals) await writeChunk(out, c);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(count, 8);
      end.writeUInt16LE(count, 10);
      end.writeUInt32LE(centralSize, 12);
      end.writeUInt32LE(offset, 16);
      await writeChunk(out, end);
      out.end();
    },
  };
};

module.exports = { createZip, createZipStream, crc32 };
