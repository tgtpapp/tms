-- Chẩn đoán (chỉ đọc, chỉ in số đếm, không in thông tin cá nhân): vì sao xếp xe báo thiếu giấy tờ dù hồ sơ có đủ.
begin transaction read only;
\echo '== Loại giấy tờ nhân sự (documents) đang hiện hành theo loại'
select doc_type, count(*) filter (where is_current) as hien_hanh, count(*) filter (where not is_current) as cu,
       count(*) filter (where is_current and expires_on is null) as khong_han, count(*) filter (where is_current and expires_on < current_date) as het_han
from public.documents group by doc_type order by doc_type;
\echo '== Lý lịch (staff_records) theo loại, có ngày hết hạn trong data'
select kind, count(*) as so_dong, count(*) filter (where nullif(data->>'het_han','') is not null) as co_het_han,
       count(*) filter (where (data->>'het_han')::date >= current_date) as con_han
from public.staff_records group by kind order by kind;
\echo '== Lái xe đang làm: thiếu giấy khám SK (documents) nhưng lý lịch có khám SK còn hạn'
select count(*) filter (where not d_ksk) as thieu_ksk_documents,
       count(*) filter (where not d_ksk and r_ksk) as co_trong_ly_lich_con_han,
       count(*) filter (where not d_th and r_th) as tap_huan_co_trong_ly_lich,
       count(*) filter (where not d_gplx) as thieu_gplx,
       count(*) as tong_lai_xe
from (select s.id,
        exists (select 1 from public.documents d where d.staff_id = s.id and d.doc_type = 'kham_suc_khoe' and d.is_current) d_ksk,
        exists (select 1 from public.documents d where d.staff_id = s.id and d.doc_type = 'tap_huan' and d.is_current) d_th,
        exists (select 1 from public.documents d where d.staff_id = s.id and d.doc_type = 'gplx' and d.is_current) d_gplx,
        exists (select 1 from public.staff_records r where r.staff_id = s.id and r.kind = 'suc_khoe' and (r.data->>'het_han')::date >= current_date) r_ksk,
        exists (select 1 from public.staff_records r where r.staff_id = s.id and r.kind = 'dao_tao' and (r.data->>'het_han')::date >= current_date) r_th
      from public.staff_members s where s.is_active and s.position = 'lai_xe') x;
\echo '== Trùng tên nhân viên đang làm (số nhóm trùng)'
select count(*) from (select lower(full_name) from public.staff_members where is_active group by tenant_id, lower(full_name) having count(*) > 1) z;
\echo '== Trường hợp trong ảnh: số hồ sơ cùng tên, mỗi hồ sơ có bao nhiêu giấy / dòng lý lịch'
select s.is_active, s.position, (select count(*) from public.documents d where d.staff_id = s.id and d.is_current) giay,
       (select string_agg(d.doc_type, ',') from public.documents d where d.staff_id = s.id and d.is_current) loai_giay,
       (select string_agg(r.kind, ',') from public.staff_records r where r.staff_id = s.id) ly_lich
from public.staff_members s where lower(s.full_name) = lower('Nguyễn Thế Vinh');
\echo '== Xe trong ảnh: giấy tờ hiện hành / cũ theo loại'
select d.doc_type, d.is_current, d.expires_on >= current_date as con_han from public.documents d join public.vehicles v on v.id = d.vehicle_id
where upper(regexp_replace(v.plate, '[^0-9A-Za-z]', '', 'g')) = '60F00470' order by 1;
\echo '== Số xe cùng biển 60F00470'
select count(*) from public.vehicles where upper(regexp_replace(plate, '[^0-9A-Za-z]', '', 'g')) = '60F00470';
\echo '== Xe đang dùng thiếu BH TNDS hiện hành'
select count(*) filter (where not exists (select 1 from public.documents d where d.vehicle_id = v.id and d.doc_type = 'bh_tnds' and d.is_current)) thieu_tnds, count(*) tong
from public.vehicles v where v.is_active;
rollback;
