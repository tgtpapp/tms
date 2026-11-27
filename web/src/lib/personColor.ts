/** Màu riêng mỗi người (ngẫu nhiên theo mã hồ sơ, cố định giữa các lần mở): đầu thẻ hồ sơ + đầu trang hồ sơ */
const PERSON_COLORS = ['#2563eb', '#16a34a', '#ea580c', '#7c3aed', '#0891b2', '#db2777', '#b45309', '#0d9488', '#be123c', '#4f46e5', '#15803d', '#9333ea'];
export function personColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PERSON_COLORS[h % PERSON_COLORS.length]!;
}
