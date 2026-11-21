// So tệp chạy chính của trang đang mở với bản đang đăng: true = đã có bản mới chưa tải, null = không kiểm tra được (bản thử / mất mạng).
export async function newVersionAvailable(): Promise<boolean | null> {
  if (!import.meta.env.PROD || !navigator.onLine) return null;
  const mine = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute('src');
  if (!mine) return null;
  try {
    const html = await (await fetch('/', { cache: 'no-store' })).text();
    const live = /<script[^>]+type="module"[^>]+src="([^"]*\/assets\/[^"]+)"/.exec(html)?.[1];
    return live ? live !== mine : null;
  } catch {
    return null;
  }
}
