// In máy in nhiệt (vé, phiếu gửi hàng, phiếu dầu) như app cũ: mỗi phiếu là 1 trang dài đúng bằng nội dung phiếu
// (khổ 80 / 58mm), không in phần còn lại của màn hình → không thừa giấy, không ra trang trắng.
const MM = 25.4 / 96;

export function printThermal(): void {
  const list = [...document.querySelectorAll<HTMLElement>('.ve-list')].pop();
  const slips = list ? [...list.querySelectorAll<HTMLElement>(':scope > .ve')] : [];
  if (!list || !slips.length) { window.print(); return; }
  const w58 = list.classList.contains('w58'), pageW = w58 ? 58 : 80;
  const rules = slips.map((el, i) => {
    el.classList.add(`tpg${i}`);
    const h = Math.ceil(el.getBoundingClientRect().height * MM) + 3;
    return `.ve.tpg${i}{page:tpg${i}} @page tpg${i}{size:${pageW}mm ${h}mm;margin:0}`;
  }).join('\n');
  const st = document.createElement('style');
  st.textContent = `
@media print {
  body.thermal-printing *:not(:has(.ve-list)):not(.ve-list):not(.ve-list *) { display: none !important; }
  body.thermal-printing, body.thermal-printing *:has(.ve-list) { display: block !important; position: static !important; margin: 0 !important; padding: 0 !important;
    border: 0 !important; width: auto !important; height: auto !important; min-height: 0 !important; max-height: none !important; overflow: visible !important;
    background: #fff !important; box-shadow: none !important; transform: none !important; }
  body.thermal-printing .ve-list { position: static !important; display: block !important; width: auto !important; padding: 0 !important; margin: 0 !important; visibility: visible !important; }
  body.thermal-printing .ve-list .ve { margin: 0 auto !important; border: 0 !important; break-after: page; page-break-after: always; }
  body.thermal-printing .ve-list .ve:last-child { break-after: auto; page-break-after: auto; }
}
${rules}`;
  document.head.appendChild(st);
  document.body.classList.add('thermal-printing');
  let done = false;
  const clean = () => {
    if (done) return;
    done = true;
    document.body.classList.remove('thermal-printing');
    st.remove();
    slips.forEach((el, i) => el.classList.remove(`tpg${i}`));
    window.removeEventListener('afterprint', clean);
  };
  window.addEventListener('afterprint', clean);
  window.print();
  setTimeout(clean, 60_000);   // trình duyệt không báo đã in xong
}
