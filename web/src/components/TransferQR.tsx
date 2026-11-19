// Mã QR chuyển khoản (VietQR) cho 1 đơn vé. Nhân viên thấy tiền về tài khoản thì bấm "Đã nhận chuyển khoản".
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { bankName, cleanContent, vietQrPayload } from '../lib/vietqr';

export interface BankAccount { bin: string; account: string; name: string }

export function TransferQR(props: {
  bank: BankAccount; amount: number; code: string; holdUntil: string | null; busy: boolean;
  onConfirm: () => void; onLater: () => void;
}) {
  const { bank, amount, code, holdUntil, busy, onConfirm, onLater } = props;
  const [img, setImg] = useState<string | null>(null);
  const content = cleanContent(`VE ${code}`);

  useEffect(() => {
    void QRCode.toDataURL(vietQrPayload(bank.bin, bank.account, amount, content), { margin: 1, width: 320 }).then(setImg);
  }, [bank.bin, bank.account, amount, content]);

  return (
    <div className="transfer">
      {img && <img src={img} alt={`Mã QR chuyển khoản ${amount.toLocaleString('vi-VN')} đ`} className="transfer-qr" />}
      <dl className="info small">
        <dt>Ngân hàng</dt><dd>{bankName(bank.bin)}</dd>
        <dt>Số tài khoản</dt><dd><b>{bank.account}</b></dd>
        <dt>Chủ tài khoản</dt><dd>{bank.name}</dd>
        <dt>Số tiền</dt><dd><b>{amount.toLocaleString('vi-VN')} đ</b></dd>
        <dt>Nội dung</dt><dd><b>{content}</b></dd>
      </dl>
      <p className="muted small">
        Khách quét mã bằng app ngân hàng. Kiểm tra tiền đã về đúng số tiền, đúng nội dung rồi mới bấm xác nhận.
        {holdUntil && ` Ghế giữ đến ${new Date(holdUntil).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hour12: false })}.`}
      </p>
      <div className="actions">
        <button type="button" className="btn primary" disabled={busy} onClick={onConfirm}>Đã nhận chuyển khoản</button>
        <button type="button" className="btn link" disabled={busy} onClick={onLater}>Khách chưa chuyển – để sau</button>
      </div>
    </div>
  );
}
