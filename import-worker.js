// Copies an imported File into the Origin Private File System (dicts/<name>) in chunks.
// Uses sync access handles, which Safari has supported far longer than createWritable().
self.onmessage = async (e) => {
  const { file } = e.data;
  let ah;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('dicts', { create: true });
    const h = await dir.getFileHandle(file.name, { create: true });
    if (typeof h.createSyncAccessHandle !== 'function') {
      postMessage({ error: 'no sync access handle', fallback: true });
      return;
    }
    ah = await h.createSyncAccessHandle();
    await ah.truncate(0);
    const CHUNK = 4 << 20;
    let off = 0;
    while (off < file.size) {
      const buf = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
      let w = 0;
      while (w < buf.length) w += await ah.write(buf.subarray(w), { at: off + w });
      off += buf.length;
      postMessage({ progress: off });
    }
    await ah.flush();
    await ah.close();
    ah = null;
    postMessage({ done: true });
  } catch (err) {
    try { if (ah) await ah.close(); } catch {}
    postMessage({ error: String((err && err.message) || err) });
  }
};
