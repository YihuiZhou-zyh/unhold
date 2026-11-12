// Minimal dependency-free PDF writer (Helvetica, ASCII text, auto page breaks).
const esc = (s) => s.replace(/[^\x20-\x7E]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

function wrap(text, max = 92) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const w of para.split(' ')) {
      if ((line + ' ' + w).trim().length > max) { out.push(line); line = w; } else line = (line + ' ' + w).trim();
    }
    out.push(line);
  }
  return out;
}

export function buildPdf(blocks) {
  // blocks: [{text, size?, bold?}]
  const lines = [];
  for (const b of blocks) for (const l of wrap(b.text, b.size >= 14 ? 60 : 92)) lines.push({ t: l, size: b.size || 10, bold: b.bold });
  const pages = [];
  let cur = [], y = 800;
  for (const l of lines) {
    const h = l.size + 5;
    if (y - h < 50) { pages.push(cur); cur = []; y = 800; }
    cur.push({ ...l, y }); y -= h;
  }
  pages.push(cur);

  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const fontR = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const fontB = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const pagesId = objs.length + 1; objs.push(null);
  const kids = [];
  for (const p of pages) {
    const stream = p.map((l) => `BT /${l.bold ? 'F2' : 'F1'} ${l.size} Tf 50 ${l.y} Td (${esc(l.t)}) Tj ET`).join('\n');
    const c = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontR} 0 R /F2 ${fontB} 0 R >> >> /Contents ${c} 0 R >>`));
  }
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'binary');
}
