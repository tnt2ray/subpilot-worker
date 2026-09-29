/** Auth failures must leave the current editor and its unsaved draft intact. */
export function createApi({ t }) {
  let writing = 0;
  async function api(path, options = {}) {
    const { background: _background, ...request } = options;
    const method = (request.method || "GET").toUpperCase();
    const configWrite = path === "/api/config" && ["PUT", "PATCH"].includes(method);
    const mutation = configWrite || ["/api/telegram/unbind", "/api/telegram/bind-code"].includes(path);
    if (mutation) { writing++; }
    try {
      const headers = new Headers(request.headers);
      if (request.body && !headers.has("content-type")) headers.set("content-type", "application/json");
      const response = await fetch(path, { cache: "no-store", ...request, headers });
      if (response.status === 401) {
        throw Object.assign(Error(t("登录已过期，请在新标签页重新登录；当前草稿已保留。", "Session expired. Sign in in a new tab; your current draft is retained.")), { status: 401 });
      }
      if (!response.headers.get("content-type")?.includes("application/json")) {
        throw Object.assign(Error(t(`服务暂时无法完成请求（${response.status}），请稍后重试。`, `The service could not complete this request (${response.status}). Please retry.`)), { status: response.status });
      }
      const data = await response.json();
      if (!response.ok) throw Object.assign(Error(data.error || `${response.status}`), { status: response.status, issues: data.issues });
      return data;
    } finally {
      if (mutation) { writing--; }
    }
  }
  Object.defineProperty(api, "writing", { get: () => writing });
  return api;
}
