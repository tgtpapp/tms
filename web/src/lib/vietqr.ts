// Tạo nội dung mã QR chuyển khoản theo chuẩn VietQR (NAPAS 247, EMVCo) – tạo ngay trên máy, không gọi dịch vụ ngoài.
// Khách quét bằng app ngân hàng bất kỳ: tự điền ngân hàng, số tài khoản, số tiền, nội dung chuyển khoản.

/** Danh sách ngân hàng thường dùng (mã BIN do Ngân hàng Nhà nước cấp). Ngân hàng khác: nhập mã BIN. */
export const BANKS: { bin: string; name: string }[] = [
  { bin: '970436', name: 'Vietcombank' },
  { bin: '970415', name: 'VietinBank' },
  { bin: '970418', name: 'BIDV' },
  { bin: '970405', name: 'Agribank' },
  { bin: '970407', name: 'Techcombank' },
  { bin: '970422', name: 'MB Bank' },
  { bin: '970416', name: 'ACB' },
  { bin: '970432', name: 'VPBank' },
  { bin: '970423', name: 'TPBank' },
  { bin: '970403', name: 'Sacombank' },
  { bin: '970437', name: 'HDBank' },
  { bin: '970441', name: 'VIB' },
  { bin: '970443', name: 'SHB' },
  { bin: '970431', name: 'Eximbank' },
  { bin: '970426', name: 'MSB' },
  { bin: '970448', name: 'OCB' },
  { bin: '970440', name: 'SeABank' },
  { bin: '970449', name: 'LPBank' },
  { bin: '970409', name: 'Bac A Bank' },
  { bin: '970412', name: 'PVcomBank' },
  { bin: '970438', name: 'BaoViet Bank' },
  { bin: '970400', name: 'Saigonbank' },
  { bin: '970419', name: 'NCB' },
  { bin: '970428', name: 'Nam A Bank' },
  { bin: '970425', name: 'ABBANK' },
  { bin: '970427', name: 'VietABank' },
  { bin: '970452', name: 'Kienlongbank' },
  { bin: '970454', name: 'Viet Capital Bank' },
];
export const bankName = (bin: string) => BANKS.find((b) => b.bin === bin)?.name ?? `Ngân hàng mã ${bin}`;

const tlv = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;

/** CRC-16/CCITT-FALSE (đa thức 0x1021, khởi tạo 0xFFFF) – yêu cầu của chuẩn EMVCo */
function crc16(s: string): string {
  let crc = 0xffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Nội dung chuyển khoản: chỉ chữ không dấu, số, khoảng trắng; tối đa 25 ký tự */
export function cleanContent(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'D').replace(/[^0-9A-Za-z ]/g, ' ')
    .replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 25);
}

export function vietQrPayload(bin: string, account: string, amount: number, content: string): string {
  const merchant = tlv('00', 'A000000727') + tlv('01', tlv('00', bin) + tlv('01', account)) + tlv('02', 'QRIBFTTA');
  const body = tlv('00', '01') + tlv('01', '12') + tlv('38', merchant) + tlv('53', '704')
    + tlv('54', String(Math.round(amount))) + tlv('58', 'VN') + tlv('62', tlv('08', cleanContent(content)));
  const withCrc = `${body}6304`;
  return withCrc + crc16(withCrc);
}
