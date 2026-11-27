// Xác nhận trên chính điện thoại bằng vân tay / Face ID / mã khóa máy (WebAuthn, khóa của máy, không gửi lên máy chủ).
// Lần đầu: tạo khóa xác thực trên máy (máy hỏi vân tay / khuôn mặt / mã khóa). Các lần sau: máy hỏi lại để xác nhận.
// Đây là bước chặn tại máy (người cầm điện thoại phải là chủ máy), không thay cho phân quyền phía máy chủ.
const KEY = 'tms.sinh_trac';
const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export async function bioAvailable(): Promise<boolean> {
  try {
    return !!window.PublicKeyCredential && window.isSecureContext
      && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch { return false; }
}

function saved(uid: string): string | null {
  try { return (JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>)[uid] ?? null; } catch { return null; }
}
function save(uid: string, id: string) {
  try { const m = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>; m[uid] = id; localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* bỏ qua */ }
}

/** true = chủ máy đã xác nhận; false = hủy / không xác nhận được */
export async function bioConfirm(uid: string, label: string): Promise<boolean> {
  const id = saved(uid);
  try {
    if (id) {
      const r = await navigator.credentials.get({ publicKey: {
        challenge: rnd(32), rpId: location.hostname, userVerification: 'required', timeout: 60000,
        allowCredentials: [{ type: 'public-key', id: unb64u(id), transports: ['internal'] }],
      } });
      return !!r;
    }
    const c = await navigator.credentials.create({ publicKey: {
      challenge: rnd(32), rp: { name: 'TMS', id: location.hostname },
      user: { id: new TextEncoder().encode(uid).slice(0, 64), name: label, displayName: label },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      timeout: 60000, attestation: 'none',
    } }) as PublicKeyCredential | null;
    if (!c) return false;
    save(uid, b64u(c.rawId));
    return true;
  } catch {
    return false;
  }
}
