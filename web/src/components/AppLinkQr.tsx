// Cấu hình: mã QR mở app (địa chỉ của chính trang đang chạy) – in dán ở quầy / phát cho nhân viên quét để mở và cài app.
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export function AppLinkQr() {
  const url = window.location.origin;
  const [img, setImg] = useState('');
  useEffect(() => { void QRCode.toDataURL(url, { margin: 2, width: 600, errorCorrectionLevel: 'M' }).then(setImg); }, [url]);
  return (
    <section className="card form">
      <h2>Mã QR mở app</h2>
      {img && <img src={img} alt={`Mã QR mở ${url}`} width={220} height={220} style={{ alignSelf: 'flex-start' }} />}
      <p className="small"><b>{url}</b></p>
      <div className="actions">
        <a className="btn primary" href={img} download="ma-qr-mo-app.png">Tải ảnh mã QR</a>
      </div>
    </section>
  );
}
