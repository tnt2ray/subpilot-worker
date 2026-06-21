export const LOGIN_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>SubPilot 登录</title>
    <style>
      :root {
        --canvas: #faf9f5;
        --surface-soft: #f5f0e8;
        --surface-card: #efe9de;
        --primary: #cc785c;
        --primary-active: #a9583e;
        --primary-disabled: #e6dfd8;
        --ink: #141413;
        --body: #3d3d3a;
        --body-strong: #252523;
        --muted: #6c6a64;
        --hairline: #e6dfd8;
        --hairline-soft: #ebe6df;
        --error: #c64545;
        --on-primary: #ffffff;
        --display: "Tiempos Headline", "Cormorant Garamond", "EB Garamond", Georgia, serif;
        --sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: var(--body);
        background: var(--canvas);
        font-family: var(--sans);
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-width: 320px;
        background: var(--canvas);
        color: var(--body);
        font-family: var(--sans);
        font-size: 14px;
        line-height: 1.55;
      }

      button,
      input {
        font: inherit;
      }

      .header {
        min-height: 64px;
        padding: 12px 24px;
        display: flex;
        align-items: center;
        color: var(--ink);
        background: var(--canvas);
        border-bottom: 1px solid var(--hairline);
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .mark {
        width: 40px;
        height: 40px;
        border-radius: 8px;
        display: grid;
        place-items: center;
        background: var(--primary);
        color: var(--on-primary);
        font-weight: 700;
      }

      .brand strong {
        display: block;
        color: var(--ink);
        font-size: 18px;
        font-weight: 600;
        line-height: 1.1;
      }

      main {
        width: 100%;
        max-width: 1480px;
        margin: 0 auto;
        padding: 32px;
      }

      .panel {
        max-width: 760px;
        overflow: hidden;
        border: 1px solid var(--hairline);
        border-radius: 12px;
        background: var(--surface-card);
      }

      .title {
        min-height: 48px;
        padding: 14px 18px;
        border-bottom: 1px solid var(--hairline);
        background: var(--surface-soft);
        color: var(--ink);
        font-size: 28px;
        font-family: var(--display);
        font-weight: 400;
        letter-spacing: 0;
        line-height: 1.2;
      }

      .row {
        display: grid;
        grid-template-columns: 210px minmax(0, 1fr);
        gap: 18px;
        padding: 18px;
        border-bottom: 1px solid var(--hairline-soft);
        background: var(--canvas);
      }

      label {
        padding-top: 8px;
        color: var(--body-strong);
        font-weight: 600;
      }

      .field {
        display: grid;
        gap: 8px;
      }

      input {
        width: 100%;
        min-height: 40px;
        border: 1px solid var(--hairline);
        border-radius: 8px;
        background: var(--canvas);
        color: var(--ink);
        padding: 9px 12px;
      }

      input:focus-visible,
      button:focus-visible {
        border-color: var(--primary);
        outline: 3px solid rgba(204, 120, 92, .18);
        outline-offset: 1px;
      }

      small {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }

      .actions {
        display: flex;
        justify-content: flex-end;
        padding: 18px;
        background: var(--surface-soft);
      }

      button {
        min-height: 40px;
        border: 1px solid var(--primary);
        border-radius: 8px;
        padding: 0 20px;
        background: var(--primary);
        color: var(--on-primary);
        cursor: pointer;
        font-size: 14px;
        font-weight: 500;
        line-height: 1;
      }

      button:active {
        border-color: var(--primary-active);
        background: var(--primary-active);
      }

      button:disabled {
        border-color: var(--primary-disabled);
        background: var(--primary-disabled);
        color: var(--muted);
        cursor: not-allowed;
      }

      .error {
        min-height: 18px;
        color: var(--error);
      }

      @media (max-width: 820px) {
        main {
          padding: 20px 12px;
        }

        .row {
          grid-template-columns: 1fr;
          gap: 8px;
          padding: 16px;
        }

        label {
          padding-top: 0;
        }
      }
    </style>
  </head>
  <body>
    <header class="header">
      <div class="brand">
        <div class="mark">SP</div>
        <div>
          <strong>SubPilot</strong>
        </div>
      </div>
    </header>
    <main>
      <section class="panel">
        <div class="title">管理员登录</div>
        <form id="loginForm">
          <div class="row">
            <label for="adminToken">管理令牌</label>
            <div class="field">
              <input id="adminToken" type="password" autocomplete="current-password" placeholder="输入管理令牌" required>
              <small>请输入管理员令牌以进入控制台。</small>
              <small id="loginError" class="error"></small>
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
