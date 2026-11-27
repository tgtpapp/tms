// Câu nói trợ lý giọng nói đã tự học (dùng chung cả nhà xe): Admin xem và xóa câu học sai.
import { useEffect, useState } from 'react';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface Row { id: string; phrase: string; intent: string; uses: number; created_at: string }
const LABEL: Record<string, string> = {
  diem_toi: 'Điểm tới', thu_ho: 'Thu hộ', chuyen: 'Thông tin chuyến', nhac_lai: 'Nhắc lại', don: 'Đón khách', tra: 'Trả khách', vang: 'Khách vắng',
  hoan_tac: 'Hoàn tác', giao: 'Giao hàng', do_dau: 'Đổ dầu', chi_phi: 'Chi phí', su_co: 'Sự cố', tre_gio: 'Trễ giờ', nhan: 'Nhắn điều hành', goi: 'Gọi khách',
  'nhac:mo': 'Mở nhạc', 'nhac:tiep': 'Bài tiếp', 'nhac:truoc': 'Bài trước', 'nhac:dung': 'Tạm dừng nhạc', 'nhac:phat': 'Phát tiếp', 'nhac:to': 'To lên',
  'nhac:nho': 'Nhỏ lại', 'nhac:tat': 'Tắt nhạc',
};

export function VoicePhrases() {
  const toast = useToast();
  const [admin, setAdmin] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  async function load() {
    const r = await supabase.from('voice_phrases').select('id, phrase, intent, uses, created_at').order('created_at', { ascending: false }).limit(2000);
    if (r.error) { toast('error', r.error.message); return; }
    setRows((r.data ?? []) as Row[]);
  }
  useEffect(() => {
    void rpc<boolean>('my_is_admin', {}).then((a) => { setAdmin(a === true); if (a === true) void load(); }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!admin) return null;
  async function forget(r: Row) {
    if (!window.confirm(`Xóa câu "${r.phrase}"?`)) return;
    try { await rpc('voice_forget', { p_id: r.id }); toast('ok', 'Đã xóa'); await load(); } catch (e) { toast('error', errMsg(e)); }
  }
  return (
    <section className="card">
      <h2>Trợ lý giọng nói: câu đã học</h2>
      {rows && !rows.length && <p className="muted">Chưa có</p>}
      {rows && rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Câu nói</th><th>Lệnh</th><th>Lượt dùng</th><th>Ngày học</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.phrase}</td><td>{LABEL[r.intent] ?? r.intent}</td><td>{r.uses}</td>
                  <td>{new Date(r.created_at).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</td>
                  <td><button type="button" className="btn small link danger-text" onClick={() => void forget(r)}>Xóa</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
