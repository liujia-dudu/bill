export async function api(path, options = {}) {
  const headers = { 'X-Invoice-Client': 'local-app', ...options.headers };
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options = { ...options, body: JSON.stringify(options.body) };
  }
  const response = await fetch(`/api${path}`, { ...options, headers });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || '请求失败');
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}
export const requestKey = () => crypto.randomUUID();
