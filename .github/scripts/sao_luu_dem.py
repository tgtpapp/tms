"""Sao lưu mỗi đêm dữ liệu từng nhà xe lên Kho hồ sơ Google Drive của chính nhà xe đó (giữ 30 bản gần nhất).
Kho mã công khai nên log chỉ in số đếm, không in địa chỉ / mã kết nối / dữ liệu. Kết nối DB bằng biến PG*."""
import base64, datetime, gzip, json, sys, urllib.request
import psycopg

PAGE, KEEP = 2000, 30
VN = datetime.timezone(datetime.timedelta(hours=7))


def gas(url, key, body, timeout=300):
    req = urllib.request.Request(url, data=json.dumps({**body, 'key': key}).encode(), headers={'Content-Type': 'text/plain;charset=utf-8'})
    with urllib.request.urlopen(req, timeout=timeout) as r:   # Apps Script trả 302 → GET kết quả (urllib tự theo)
        out = json.loads(r.read().decode())
    if not out.get('ok'):
        raise RuntimeError('Apps Script báo lỗi')
    return out


def main():
    fails = 0
    with psycopg.connect(autocommit=True) as conn:
        cur = conn.cursor()
        tables = [r[0] for r in cur.execute('select tbl from app.backup_tables() order by ord').fetchall()]
        tenants = cur.execute('select t.id, t.name, d.url, d.key from public.tenants t join public.tenant_drive d on d.tenant_id = t.id order by t.created_at').fetchall()
        print(f'{len(tenants)} nhà xe đã kết nối Google Drive, {len(tables)} bảng')
        for i, (tid, name, url, key) in enumerate(tenants, 1):
            try:
                pages, rows = [], 0
                for t in tables:
                    after = None
                    while True:
                        p = cur.execute('select app.backup_page_for(%s, %s, %s, %s)', (tid, t, after, PAGE)).fetchone()[0]
                        if not p['n']:
                            break
                        pages.append({'t': t, 'rows': p['rows'], 'sig': p['sig']})
                        rows += p['n']
                        if p['n'] < PAGE or not p['last']:
                            break
                        after = p['last']
                now = datetime.datetime.now(VN)
                body = json.dumps({'format': 'tms-sao-luu', 'v': 1, 'tenant': name, 'created_at': now.isoformat(), 'pages': pages}, ensure_ascii=False)
                gz = gzip.compress(body.encode('utf-8'), 9)
                fname = f'sao-luu_{now:%Y-%m-%d_%H%M}.json.gz'
                r = gas(url, key, {'action': 'hs_put', 'path': ['Sao lưu dữ liệu'], 'name': fname, 'mime': 'application/gzip', 'data': base64.b64encode(gz).decode()})
                cur.execute('insert into public.tenant_backups (tenant_id, kind, drive_id, file_name, size_bytes, row_count) values (%s, %s, %s, %s, %s, %s)',
                            (tid, 'dem', r['id'], fname, len(gz), rows))
                # giữ 30 bản tự động gần nhất
                old = cur.execute("select id, drive_id from public.tenant_backups where tenant_id = %s and kind = 'dem' order by created_at desc offset %s", (tid, KEEP)).fetchall()
                for bid, did in old:
                    try:
                        gas(url, key, {'action': 'hs_del', 'id': did}, 60)
                    except Exception:
                        pass
                    cur.execute('delete from public.tenant_backups where id = %s', (bid,))
                print(f'Nhà xe {i}: {rows} dòng, {len(gz) // 1024} KB, xóa {len(old)} bản cũ')
            except Exception as e:   # không in chi tiết (có thể chứa địa chỉ / mã)
                fails += 1
                print(f'Nhà xe {i}: LỖI {type(e).__name__}')
    if fails:
        sys.exit(1)


if __name__ == '__main__':
    main()
