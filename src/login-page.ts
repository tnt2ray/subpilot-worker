export const LOGIN_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>SubPilot 登录</title>
    <meta name="color-scheme" content="light">
    <style>
      :root {
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif;
        color: #172033;
        background: #fff;
        font-size: 14px;
        font-synthesis: none;
        --blue: #2563eb;
        --border: #dce1e9;
        --muted: #667085;
        --surface: #f7f8fb;
        --danger: #c23139;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0; line-height: 1.55;
        min-height: 100vh; min-height: 100dvh;
        display: flex; flex-direction: column;
      }
      button, input { font: inherit; }
      .header {
        flex-shrink: 0;
        min-height: 80px;
        padding: 20px 32px;
        display: flex;
        align-items: center;
        background: var(--surface);
        border-bottom: 1px solid var(--border);
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 12px;
        color: var(--blue);
        font-size: 26px;
        font-weight: 650;
      }
      .brand svg { width: 28px; height: 28px; fill: none; stroke: currentColor; stroke-width: 2.5; }
      main {
        width: 100%; max-width: 480px; margin: 0 auto; padding: 32px 24px;
        flex: 1; display: flex; flex-direction: column; justify-content: center;
      }
      .panel { padding: 28px; border: 1px solid var(--border); border-radius: 8px; }
      h1 { margin: 0 0 8px; font-size: 24px; font-weight: 600; line-height: 1.3; }
      .description { margin: 0 0 28px; color: var(--muted); }
      label { display: block; margin-bottom: 8px; font-weight: 500; }
      .field { display: grid; gap: 8px; }
      input {
        width: 100%; min-width: 0; min-height: 44px;
        padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px;
        color: inherit; background: #fff;
      }
      input::placeholder { color: var(--muted); }
      :focus-visible { outline: 3px solid #93b4fd; outline-offset: 2px; }
      .error { min-height: 20px; color: var(--danger); font-size: 13px; overflow-wrap: anywhere; }
      .actions { margin-top: 16px; }
      button {
        width: 100%; min-height: 44px; padding: 10px 16px;
        border: 1px solid var(--blue); border-radius: 6px;
        background: var(--blue); color: #fff; cursor: pointer;
      }
      button:hover, button:active { background: #1d4ed8; border-color: #1d4ed8; }
      button:disabled { background: #b5c8ed; border-color: #b5c8ed; cursor: not-allowed; }
      @media (max-width: 520px) {
        .header { min-height: 72px; padding: 18px 20px; }
        main { padding: 24px 20px; }
        .panel { padding: 24px 20px; }
        input { font-size: 16px; }
      }
    </style>
  </head>
  <body>
    <header class="header">
      <div class="brand">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 4-7 8 7 8m6-16 7 8-7 8"/></svg>
        <span>SubPilot</span>
      </div>
    </header>
    <main>
      <section class="panel" aria-labelledby="loginTitle">
        <h1 id="loginTitle">管理员登录</h1>
        <p class="description">登录以管理订阅、规则和客户端配置。</p>
        <form id="loginForm">
          <div class="row">
            <label for="adminToken">管理令牌</label>
            <div class="field">
              <input id="adminToken" type="password" autocomplete="current-password" placeholder="输入管理令牌" aria-describedby="loginError" required>
              <small id="loginError" class="error" role="alert"></small>
            </div>
          </div>
          <div class="actions">
            <button id="loginBtn" type="submit">登录</button>
          </div>
        </form>
      </section>
    </main>
    <script>
      const form = document.getElementById("loginForm");
      const tokenInput = document.getElementById("adminToken");
      const loginButton = document.getElementById("loginBtn");
      const loginError = document.getElementById("loginError");

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        loginButton.disabled = true;
        loginError.textContent = "";
        try {
          const response = await fetch("/api/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: tokenInput.value })
          });
          if (!response.ok) {
            loginError.textContent = "令牌无效。";
            return;
          }
          window.location.assign("/");
        } catch {
          loginError.textContent = "登录失败，请稍后重试。";
        } finally {
          loginButton.disabled = false;
        }
      });
    </script>
  </body>
</html>`;
