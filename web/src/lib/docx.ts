// Đọc file Word (.docx) thành HTML đơn giản để soạn văn bản – không cần thư viện:
// giải nén bằng DecompressionStream của trình duyệt, đọc word/document.xml: đoạn văn, chữ đậm / nghiêng / gạch chân,
// cỡ chữ, căn lề, thụt đầu dòng, bảng, xuống dòng. Ảnh / hình vẽ trong file không lấy (cần thì chèn lại sau).

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const buf = await new Response(new Blob([data.slice() as Uint8Array<ArrayBuffer>]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}

/** Lấy 1 tệp trong gói zip (docx là zip). */
async function unzipEntry(zip: Uint8Array, name: string): Promise<string | null> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('File không phải Word (.docx)');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const fname = dec.decode(zip.subarray(p + 46, p + 46 + nl));
    if (fname === name) {
      const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
      const raw = zip.subarray(start, start + csize);
      return dec.decode(method === 0 ? raw : await inflate(raw));
    }
    p += 46 + nl + el + cl;
  }
  return null;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const kids = (el: Element, local: string) => Array.from(el.children).filter((c) => c.localName === local);
const kid = (el: Element | undefined | null, local: string) => (el ? kids(el, local)[0] : undefined);
const val = (el: Element | undefined) => el?.getAttributeNS(W, 'val') ?? el?.getAttribute('w:val') ?? null;
const on = (el: Element | undefined) => !!el && !['0', 'false', 'none'].includes(String(val(el) ?? 'true'));

function run(r: Element): string {
  const pr = kid(r, 'rPr');
  let out = '';
  for (const c of Array.from(r.children)) {
    if (c.localName === 't') out += esc(c.textContent ?? '');
    else if (c.localName === 'tab') out += '&emsp;&emsp;';
    else if (c.localName === 'br' || c.localName === 'cr') out += '<br>';
  }
  if (!out) return '';
  const sz = Number(val(kid(pr, 'sz'))) / 2;
  if (sz) out = `<span style="font-size:${sz}pt">${out}</span>`;
  if (on(kid(pr, 'u'))) out = `<u>${out}</u>`;
  if (on(kid(pr, 'i'))) out = `<i>${out}</i>`;
  if (on(kid(pr, 'b'))) out = `<b>${out}</b>`;
  return out;
}

function para(p: Element): string {
  const pr = kid(p, 'pPr');
  const jc = val(kid(pr, 'jc'));
  const align = jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : jc === 'both' || jc === 'distribute' ? 'justify' : '';
  const ind = kid(pr, 'ind');
  const first = Number(ind?.getAttributeNS(W, 'firstLine') ?? ind?.getAttribute('w:firstLine') ?? 0) / 20;   // twip → pt
  const left = Number(ind?.getAttributeNS(W, 'left') ?? ind?.getAttribute('w:left') ?? ind?.getAttributeNS(W, 'start') ?? 0) / 20;
  let html = '';
  for (const c of Array.from(p.children)) {
    if (c.localName === 'r') html += run(c);
    else if (c.localName === 'hyperlink' || c.localName === 'smartTag' || c.localName === 'ins') html += Array.from(c.children).filter((x) => x.localName === 'r').map(run).join('');
  }
  const st = [align && `text-align:${align}`, first && `text-indent:${first}pt`, left && `margin-left:${left}pt`, 'margin:0 0 4px'].filter(Boolean).join(';');
  return `<p style="${st}">${html || '&nbsp;'}</p>`;
}

function table(t: Element): string {
  const rows = kids(t, 'tr').map((tr) => `<tr>${kids(tr, 'tc').map((tc) => {
    const span = Number(val(kid(kid(tc, 'tcPr'), 'gridSpan'))) || 1;
    return `<td${span > 1 ? ` colspan="${span}"` : ''} style="vertical-align:top;padding:2px 6px">${body(tc)}</td>`;
  }).join('')}</tr>`).join('');
  const borders = kid(kid(t, 'tblPr'), 'tblBorders');
  const lined = !!borders && kids(borders, 'top').some((b) => val(b) && val(b) !== 'none' && val(b) !== 'nil');
  return `<table style="width:100%;border-collapse:collapse${lined ? ';border:1px solid #000' : ''}" ${lined ? 'border="1"' : ''}>${rows}</table>`;
}

function body(el: Element): string {
  return Array.from(el.children).map((c) => (c.localName === 'p' ? para(c) : c.localName === 'tbl' ? table(c) : c.localName === 'sdt' ? body(kid(c, 'sdtContent') ?? c) : '')).join('');
}

/** File .docx → HTML (đoạn văn, bảng). */
export async function docxToHtml(file: File): Promise<string> {
  if (!/\.docx$/i.test(file.name)) throw new Error('Chỉ nhận file Word dạng .docx (file .doc cũ: mở bằng Word rồi Lưu thành .docx)');
  if (typeof DecompressionStream === 'undefined') throw new Error('Trình duyệt quá cũ, không mở được file Word. Hãy cập nhật Chrome / Safari');
  const xml = await unzipEntry(new Uint8Array(await file.arrayBuffer()), 'word/document.xml');
  if (!xml) throw new Error('Không thấy nội dung văn bản trong file Word');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const b = doc.getElementsByTagNameNS(W, 'body')[0];
  if (!b) throw new Error('File Word không đọc được');
  return body(b);
}
