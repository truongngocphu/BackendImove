// TH79 iMove Browser Debug Logger
// Import file này 1 lần ở main.jsx/main.tsx để xem API lỗi rõ trong F12 Console.
// Ví dụ: import './browser_debug';

(() => {
  if (typeof window === 'undefined' || window.__IMOVE_DEBUG_INSTALLED__) return;
  window.__IMOVE_DEBUG_INSTALLED__ = true;

  const REDACT_KEYS = /password|pass|token|authorization|cookie|secret|private.?key|api.?key|credential/i;

  function sanitize(value, depth = 0) {
    if (depth > 5) return '[MAX_DEPTH]';
    if (value == null) return value;
    if (typeof value === 'string') {
      if (value.length > 3000) return value.slice(0, 3000) + '…';
      return value;
    }
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.slice(0, 30).map(v => sanitize(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEYS.test(k) ? '[REDACTED]' : sanitize(v, depth + 1);
    }
    return out;
  }

  async function readResponseBody(response) {
    try {
      const clone = response.clone();
      const type = clone.headers.get('content-type') || '';
      if (type.includes('application/json')) return sanitize(await clone.json());
      const text = await clone.text();
      return text ? text.slice(0, 3000) : null;
    } catch (e) {
      return `[Không đọc được response body: ${e?.message || e}]`;
    }
  }

  function headersToObject(headers) {
    try {
      const out = {};
      headers.forEach((v, k) => {
        out[k] = REDACT_KEYS.test(k) ? '[REDACTED]' : v;
      });
      return out;
    } catch (_) {
      return {};
    }
  }

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function imoveDebugFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url;
    const method = String(init?.method || (typeof input !== 'string' ? input?.method : '') || 'GET').toUpperCase();
    const started = performance.now();

    let requestBody = null;
    try {
      if (init?.body && typeof init.body === 'string') {
        try { requestBody = sanitize(JSON.parse(init.body)); }
        catch (_) { requestBody = init.body.slice(0, 3000); }
      }
    } catch (_) {}

    try {
      const response = await originalFetch(input, init);
      const elapsed = Math.round(performance.now() - started);
      const requestId = response.headers.get('x-request-id');
      const driverStatus = response.headers.get('x-imove-driver-status');
      const reason = response.headers.get('x-imove-reason');
      const body = await readResponseBody(response);

      const label = `[iMove API] ${method} ${url} -> ${response.status} (${elapsed}ms)`;
      const detail = {
        requestId,
        driverStatus,
        reason,
        requestBody,
        responseBody: body,
        responseHeaders: headersToObject(response.headers),
      };

      if (!response.ok) {
        console.groupCollapsed(`%c${label}`, 'color:#d32f2f;font-weight:bold');
        console.error('API ERROR', detail);
        console.groupEnd();
      } else if (window.IMOVE_DEBUG === true || driverStatus || reason) {
        console.groupCollapsed(`%c${label}`, 'color:#1976d2;font-weight:bold');
        console.log(detail);
        console.groupEnd();
      }

      return response;
    } catch (error) {
      const elapsed = Math.round(performance.now() - started);
      console.group(`[iMove NETWORK ERROR] ${method} ${url} (${elapsed}ms)`);
      console.error(error);
      console.log({ requestBody });
      console.groupEnd();
      throw error;
    }
  };

  window.addEventListener('error', (event) => {
    console.group('[iMove JS ERROR]');
    console.error(event.error || event.message);
    console.log({ file: event.filename, line: event.lineno, column: event.colno });
    console.groupEnd();
  });

  window.addEventListener('unhandledrejection', (event) => {
    console.group('[iMove UNHANDLED PROMISE]');
    console.error(event.reason);
    console.groupEnd();
  });

  console.info('[TH79 iMove Debug] Browser logger đã bật. Mở F12 > Console. Đặt window.IMOVE_DEBUG=true để log cả request thành công.');
})();
