// Soạn văn bản tự do (mod Văn bản): mở file Word làm bản nháp, sửa trực tiếp, chèn ô điền tự động {…},
// nhờ AI sửa theo yêu cầu (người soạn xem lại rồi mới lưu).
import { sanitizeHtml } from '../lib/sanitize';
import { useEffect, useRef, useState } from 'react';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { docxToHtml } from '../lib/docx';
import { FIELDS } from '../lib/officialDocs';
import { errMsg, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

export function WordEditor({ html, onChange }: { html: string; onChange: (html: string) => void }) {
  const toast = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const [ver, setVer] = useState(0);            // đổi khi thay cả nội dung (mở Word / AI) để vẽ lại khung soạn
  const [ask, setAsk] = useState('');
  const [busy, setBusy] = useState('');
  const [undo, setUndo] = useState<string | null>(null);
  useEffect(() => { if (ref.current && ref.current.innerHTML !== html) ref.current.innerHTML = sanitizeHtml(html); }, [ver]);   // eslint-disable-line react-hooks/exhaustive-deps
  const replaceAll = (h: string) => { onChange(sanitizeHtml(h)); setVer((v) => v + 1); };
  const cmd = (c: string, v?: string) => { ref.current?.focus(); document.execCommand(c, false, v); onChange(ref.current?.innerHTML ?? ''); };

  async function open(file: File) {
    setBusy('Đang đọc file Word…');
    try { const h = await docxToHtml(file); setUndo(html); replaceAll(h); toast('ok', `Đã mở ${file.name}`); }
    catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  }
  async function ai() {
    if (!ask.trim()) return toast('error', 'Ghi yêu cầu cho AI, vd: "Soạn quyết định khen thưởng lái xe {Họ tên} 2.000.000 đồng vì chạy an toàn cả năm"');
    setBusy('AI đang soạn…');
    try {
      const { data, error } = await supabase.functions.invoke('doc-writer', { body: { html: ref.current?.innerHTML ?? html, instruction: ask } });
      if (error) {
        const msg = error instanceof FunctionsHttpError ? ((await error.context.json().catch(() => null)) as { error?: string } | null)?.error : null;
        throw new Error(msg ?? 'AI chưa soạn được, thử lại sau');
      }
      setUndo(ref.current?.innerHTML ?? html);
      replaceAll((data as { html: string }).html);
      toast('ok', 'AI đã sửa văn bản. Xem lại kỹ trước khi lưu');
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  }

  return (
    <div className="word-ed">
      <div className="word-bar">
        <label className="upload"><span>📄 Mở file Word (.docx)</span>
          <input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" aria-label="Mở file Word"
                 onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void open(f); }} /></label>
        <button type="button" className="btn small" title="Đậm" onClick={() => cmd('bold')}><b>B</b></button>
        <button type="button" className="btn small" title="Nghiêng" onClick={() => cmd('italic')}><i>I</i></button>
        <button type="button" className="btn small" title="Gạch chân" onClick={() => cmd('underline')}><u>U</u></button>
        <button type="button" className="btn small" title="Căn trái" onClick={() => cmd('justifyLeft')}>⯇</button>
        <button type="button" className="btn small" title="Căn giữa" onClick={() => cmd('justifyCenter')}>≡</button>
        <button type="button" className="btn small" title="Căn đều hai bên" onClick={() => cmd('justifyFull')}>☰</button>
        <button type="button" className="btn small" title="Căn phải" onClick={() => cmd('justifyRight')}>⯈</button>
        <select aria-label="Chèn ô điền tự động" value="" onChange={(e) => { if (e.target.value) cmd('insertText', e.target.value); }}>
          <option value="">Chèn ô tự điền…</option>
          {FIELDS.map(([k, l]) => <option key={k} value={k}>{k} · {l}</option>)}
        </select>
        {undo !== null && <button type="button" className="btn small" onClick={() => { const u = undo; setUndo(null); replaceAll(u); }}>↶ Hoàn tác</button>}
      </div>
      <div ref={ref} className="word-page" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="Nội dung văn bản"
           onInput={() => onChange(ref.current?.innerHTML ?? '')} />
      <div className="word-ai">
        <textarea rows={2} value={ask} onChange={(e) => setAsk(e.target.value)} aria-label="Yêu cầu cho AI"
                  placeholder='Nhờ AI soạn / sửa theo nhu cầu nhà xe, vd: "Soạn quyết định điều động {Họ tên} sang tuyến Biên Hòa - Vũng Tàu từ 01/12" hoặc "Sửa lại cho trang trọng, thêm điều khoản thi hành"' />
        <button type="button" className="btn small primary" disabled={!!busy} onClick={() => void ai()}>✨ AI soạn / sửa</button>
      </div>
      {busy && <p className="upload">{busy}</p>}
      <p className="small muted">Các ô {'{…}'} (vd {'{Họ tên}'}, {'{Số văn bản}'}, {'{Ngày ký}'}, {'{Chữ ký giám đốc}'}) tự thay bằng thông tin thật khi xem, in, lưu: chọn người ở ô "Người liên quan".
        Số văn bản cấp khi lưu. AI có thể sai: luôn đọc lại trước khi lưu.</p>
    </div>
  );
}
