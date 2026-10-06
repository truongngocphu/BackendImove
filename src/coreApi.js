import { CORE_BACKEND_URL, coreUrl, fetchWithTimeout } from './apiRuntime.js';

const ACCESS_KEY = 'imove_core_admin_access_token';
const USER_KEY = 'imove_core_admin_user';

export function hasCoreAdminSession() {
  return Boolean(localStorage.getItem(ACCESS_KEY));
}

export function currentCoreAdmin() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch (_) {
    return null;
  }
}

export function clearCoreAdminSession() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem('imove_admin_session');
}

function healthLooksLikeCore(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const service = String(payload.service || payload.name || '').trim().toLowerCase();
  return Boolean(
    payload.ok === true ||
    payload.backend === true ||
    payload.components?.api?.ok === true ||
    service === 'th79_imove_core' ||
    service === 'th79 imove api' ||
    service.includes('imove')
  );
}

export async function getCoreConnection(refresh = false) {
  try {
    const response = await fetchWithTimeout(
      coreUrl('/health'),
      {
        cache: 'no-store',
        headers: refresh ? { 'Cache-Control': 'no-cache' } : undefined,
      },
      8000
    );

    const payload = await response.json().catch(() => ({}));
    // IMPORTANT: ready=false does NOT mean Core is offline.
    // Optional components such as FCM can make readiness false while API/Mongo/dispatch are healthy.
    const connected = response.ok && healthLooksLikeCore(payload);

    return {
      connected,
      configured: true,
      baseUrl: CORE_BACKEND_URL,
      source: 'DIRECT_PUBLIC_BACKEND',
      status: response.status,
      health: payload,
      ready: payload?.ready === true,
      message: connected
        ? 'Core Backend đã kết nối.'
        : (payload?.message || `Core Backend phản hồi HTTP ${response.status}.`),
    };
  } catch (error) {
    return {
      connected: false,
      configured: true,
      baseUrl: CORE_BACKEND_URL,
      source: 'DIRECT_PUBLIC_BACKEND',
      message: error?.name === 'AbortError'
        ? 'Core Backend phản hồi quá thời gian.'
        : `Không kết nối được Core Backend: ${error?.message || String(error)}`,
    };
  }
}

export async function coreAdminLogin({ login, password }) {
  // Do not block login merely because the health probe reports ready=false.
  // Try the real auth endpoint directly; it is the authoritative check.
  let response;
  try {
    response = await fetchWithTimeout(
      coreUrl('/api/admin-auth/login'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password }),
        cache: 'no-store',
      },
      12000
    );
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Core Backend phản hồi quá thời gian.');
    }
    throw new Error(`Không kết nối được Core Backend: ${error?.message || String(error)}`);
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload?.message || `Đăng nhập thất bại (${response.status})`);
  }

  if (!payload?.accessToken) {
    throw new Error('Backend không trả Access Token quản trị.');
  }

  localStorage.setItem(ACCESS_KEY, payload.accessToken);
  localStorage.setItem(USER_KEY, JSON.stringify(payload.user || null));
  localStorage.setItem('imove_admin_session', '1');

  return payload;
}

export function coreAdminLogout() {
  clearCoreAdminSession();
}

export async function coreApiRequest(path, options = {}) {
  const token = localStorage.getItem(ACCESS_KEY);

  if (!token) {
    throw new Error('Chưa đăng nhập Core Admin.');
  }

  const headers = {
    ...(options.headers || {}),
    Authorization: `Bearer ${token}`,
  };

  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  let response;
  try {
    response = await fetchWithTimeout(
      coreUrl(path),
      {
        ...options,
        headers,
        cache: 'no-store',
      },
      Number(options.timeoutMs || 15000)
    );
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Core Backend phản hồi quá thời gian.');
    }
    throw new Error(`Không kết nối được Core Backend: ${error?.message || String(error)}`);
  }

  const payload = await response.json().catch(() => ({}));

  if (response.status === 401) {
    clearCoreAdminSession();
    window.dispatchEvent(new Event('imove:admin-auth-expired'));
  }

  if (!response.ok) {
    const missing = Array.isArray(payload?.missing)
      ? `\n• ${payload.missing.join('\n• ')}`
      : '';
    throw new Error((payload?.message || `API lỗi ${response.status}`) + missing);
  }

  return payload;
}

export async function openCorePrivateFile(fileId) {
  const token = localStorage.getItem(ACCESS_KEY);
  if (!token) throw new Error('Chưa đăng nhập Core Admin.');

  const popup = window.open('', '_blank');
  try {
    const response = await fetchWithTimeout(
      coreUrl(`/api/kyc/files/${encodeURIComponent(fileId)}`),
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      },
      20000
    );

    if (response.status === 401) {
      clearCoreAdminSession();
      window.dispatchEvent(new Event('imove:admin-auth-expired'));
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload?.message || `Không thể mở file (${response.status})`);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    if (popup) popup.location.href = url;
    else window.open(url, '_blank', 'noopener,noreferrer');
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    if (popup) popup.close();
    throw error;
  }
}

export const CORE_API_URL = CORE_BACKEND_URL;
