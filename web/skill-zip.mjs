// Read one UTF-8 SKILL.md directly from the ZIP. Other entries are never extracted.
export async function importSkillZip(file) {
  if (file.size > 5 * 1024 * 1024) throw new Error('Choose a ZIP smaller than 5 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const u16 = offset => view.getUint16(offset, true);
  const u32 = offset => view.getUint32(offset, true);
  const decoder = new TextDecoder('utf-8', {fatal:true});
  const maxDocumentBytes = 64 * 1024;
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) &&
    (u32(end) !== 0x06054b50 || end + 22 + u16(end + 20) !== bytes.length)) end--;
  if (end < Math.max(0, bytes.length - 65557) || u16(end + 4) || u16(end + 6) ||
      u16(end + 8) !== u16(end + 10)) throw new Error('Choose a valid, single-volume ZIP.');

  const count = u16(end + 10);
  const directorySize = u32(end + 12);
  const directory = u32(end + 16);
  if (directory + directorySize !== end) throw new Error('The ZIP directory is invalid.');
  let offset = directory;
  let entry;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || u32(offset) !== 0x02014b50) throw new Error('The ZIP directory entry is invalid.');
    const nameEnd = offset + 46 + u16(offset + 28);
    const next = nameEnd + u16(offset + 30) + u16(offset + 32);
    if (next > end) throw new Error('The ZIP directory entry is incomplete.');
    const path = new TextDecoder().decode(bytes.subarray(offset + 46, nameEnd)).split('/');
    if (path.at(-1) === 'SKILL.md' && !path.includes('__MACOSX')) {
      if (path.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) {
        throw new Error('Invalid SKILL.md path.');
      }
      if (entry) throw new Error('Include one SKILL.md per ZIP.');
      entry = {path, flags:u16(offset + 8), method:u16(offset + 10), compressed:u32(offset + 20),
        size:u32(offset + 24), local:u32(offset + 42)};
    }
    offset = next;
  }
  if (offset !== end) throw new Error('The ZIP directory size is invalid.');
  if (!entry) throw new Error('The ZIP must contain a SKILL.md file.');
  if (entry.flags & 1 || ![0, 8].includes(entry.method)) throw new Error('Use an unencrypted ZIP with Store or Deflate compression.');
  if (entry.size > maxDocumentBytes) throw new Error('SKILL.md exceeds 64 KB.');
  if (entry.local + 30 > directory || u32(entry.local) !== 0x04034b50) throw new Error('SKILL.md is missing from the ZIP.');
  const start = entry.local + 30 + u16(entry.local + 26) + u16(entry.local + 28);
  if (start + entry.compressed > directory) throw new Error('SKILL.md data is incomplete.');

  const raw = new Blob([bytes.subarray(start, start + entry.compressed)]);
  const stream = entry.method === 0 ? raw.stream() : raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const buffer = new Uint8Array(entry.size);
  let written = 0;
  try {
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      if (written + part.value.length > buffer.length) throw new Error('SKILL.md exceeds its declared size.');
      buffer.set(part.value, written);
      written += part.value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (written !== entry.size) throw new Error('SKILL.md data is incomplete.');
  const document = decoder.decode(buffer).replaceAll('\r\n', '\n');
  const frontmatter = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(document);
  const title = frontmatter?.[1].match(/^name:[ \t]*(.+)$/m)?.[1].trim();
  const name = title?.replace(/^(['"])(.*)\1$/, '$2') || entry.path.at(-2) || file.name.replace(/\.zip$/i, '');
  const instructions = document.slice(frontmatter?.[0].length ?? 0).trim();
  if (name.length > 80 || !instructions || instructions.length > 16000) {
    throw new Error('Use a name up to 80 characters and 1–16,000 characters of instructions.');
  }
  return {name, instructions, requires:null};
}
