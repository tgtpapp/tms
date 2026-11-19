-- Tên tuyến chiều về (hiện ở lịch chạy, bán vé, lệnh vận chuyển). Để trống = đảo tên chiều đi ("Biên Hòa - Vũng Tàu" → "Vũng Tàu - Biên Hòa").
alter table public.routes add column name_ve text;
