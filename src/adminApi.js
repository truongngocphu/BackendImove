import { coreUrl, fetchWithTimeout } from './apiRuntime.js';

const ACCESS_KEY = 'imove_core_admin_access_token';

export function adminAccessToken(){
  return localStorage.getItem(ACCESS_KEY) || '';
}

export async function adminApiRequest(path, options = {}){
  const token = adminAccessToken();
  if(!token) throw new Error('Chưa đăng nhập quản trị.');

  const headers = {
    ...(options.headers || {}),
    Authorization: `Bearer ${token}`,
  };

  if(options.body && !(options.body instanceof FormData)){
    headers['Content-Type'] = 'application/json';
  }

  let response;
  try {
    response = await fetchWithTimeout(coreUrl(`/api${path}`), {
      ...options,
      headers,
      cache: 'no-store',
    }, Number(options.timeoutMs || 15000));
  } catch (error) {
    if(error?.name === 'AbortError') throw new Error('Backend phản hồi quá thời gian.');
    throw new Error(`Không kết nối được Backend: ${error?.message || String(error)}`);
  }

  const payload = await response.json().catch(() => ({}));
  if(response.status === 401){
    window.dispatchEvent(new Event('imove:admin-auth-expired'));
  }
  if(!response.ok){
    throw new Error(payload?.message || `API lỗi ${response.status}`);
  }
  return payload;
}

export function hasPermission(access, permission){
  if(!permission) return true;
  const permissions = Array.isArray(access?.permissions) ? access.permissions : [];
  return permissions.includes('*') || permissions.includes(permission);
}
