import { createContext, Script } from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractFunctionSource, readPublicFile } from "./helpers/public-assets";

describe("CodeMirror 6 admin editor contract", () => {
  it("syncs proxy-node edits and saves the latest value without a CodeMirror 5 state object", async () => {
    const app = readPublicFile("app.js");
    const initialNode = {
      id: "node-1",
      config: "Old = socks5, 1.1.1.1, 1080",
      chainFilter: [],
      enabled: true,
      chainExit: false,
      includeInGroups: false
    };
    const nextConfig = "New = socks5, 2.2.2.2, 1080";
    const functions = [
      "initConfigCodeEditors",
      "updateProxyNode",
      "pageDraft",
      "pageBaseline",
      "hasUnsavedChanges",
      "cloneConfig",
      "setSaveStatus",
      "isSaveButtonDisabled",
      "updateSaveAvailability"
    ].map((name) => extractFunctionSource(app, name)).join("\n");
    const saveActivePage = `async ${extractFunctionSource(app, "saveActivePage")}`;
    const sandbox: {
      run?: () => Promise<void>;
      afterInput?: {
        textareaValue: string;
        stateValue: string;
        saveDisabled: boolean;
        unsaved: boolean;
        inputBubbled: boolean;
        autoHeight: boolean;
      };
      savedRequest?: {
        url: string;
        method: string;
        body: { proxyNodes: Array<{ config: string }> };
      };
    } = {};
    const context = createContext(sandbox);

    new Script(`
      class Event {
        constructor(type, init = {}) {
          this.type = type;
          this.bubbles = Boolean(init.bubbles);
        }
      }
      const queueMicrotask = (callback) => Promise.resolve().then(callback);
      const configCodeEditors = new Map();
      const activePage = "proxy-nodes";
      let saveStatusResetTimer = 0;
      let clientSessionVersion = 0;
      let configSaveInFlight = false;
      let logoutInFlight = false;
      let state = { proxyNodes: [${JSON.stringify(initialNode)}] };
      let lastSavedState = JSON.parse(JSON.stringify(state));
      const refs = {
        saveBtn: {
          dataset: { state: "idle" },
          textContent: "",
          disabled: true
        }
      };
      const requests = [];
      const receivedOptions = [];
      const t = (key) => key;
      const render = () => {};
      const validateProxyNodes = () => ({ errors: [] });
      const request = async (url, options) => {
        const body = JSON.parse(options.body);
        requests.push({ url, method: options.method, body });
        return { ...state, ...body };
      };
      const requestConfigSave = async (patch) => request("/api/config", {
        method: "PATCH",
        body: JSON.stringify(patch)
      });
      const syncLogoutButtonState = () => {};
      const textarea = {
        value: ${JSON.stringify(initialNode.config)},
        readOnly: false,
        dataset: { field: "config" },
        inputBubbled: false,
        dispatchEvent(event) {
          if (event.type === "input") {
            updateProxyNode("node-1", this);
            this.inputBubbled = event.bubbles;
            if (event.bubbles) queueMicrotask(updateSaveAvailability);
          }
          return true;
        }
      };
      let editor;
      let changeHandler;
      const window = {
        clearTimeout() {},
        setTimeout() { return 0; },
        alert() {},
        SubPilotCodeMirror: {
          fromTextArea(_textarea, options) {
            receivedOptions.push(options);
            editor = {
              subpilotSyncing: false,
              value: textarea.value,
              on(eventName, handler) {
                if (eventName === "change") changeHandler = handler;
              },
              save() {
                textarea.value = this.value;
              }
            };
            return editor;
          }
        }
      };
      const configCodeTextareas = () => [textarea];
      const configCodeEditorMode = () => "proxy-config";
      const configCodeEditorMaxRows = () => 10;
      const configPolicyHighlightCandidates = () => [];
      const syncConfigCodeEditor = () => {};
      const resizeConfigCodeEditor = () => {};

      ${functions}
      ${saveActivePage}
      initConfigCodeEditors();

      globalThis.run = async () => {
        editor.value = ${JSON.stringify(nextConfig)};
        changeHandler();
        await Promise.resolve();

        globalThis.afterInput = {
          textareaValue: textarea.value,
          stateValue: state.proxyNodes[0].config,
          saveDisabled: refs.saveBtn.disabled,
          unsaved: hasUnsavedChanges(activePage),
          inputBubbled: textarea.inputBubbled,
          autoHeight: receivedOptions[0].autoHeight
        };

        await saveActivePage(activePage);
        globalThis.savedRequest = requests[0];
      };
    `).runInContext(context);

    if (!sandbox.run) throw new Error("VM test runner was not initialized");
    await sandbox.run();

    expect(sandbox.afterInput).toEqual({
      textareaValue: nextConfig,
      stateValue: nextConfig,
      saveDisabled: false,
      unsaved: true,
      inputBubbled: true,
      autoHeight: true
    });
    expect(sandbox.savedRequest?.url).toBe("/api/config");
    expect(sandbox.savedRequest?.method).toBe("PATCH");
    expect(sandbox.savedRequest?.body.proxyNodes[0]?.config).toBe(nextConfig);
  });

  it("declares persistent project classes through CM6 editor attributes", () => {
    const app = readPublicFile("app.js");
    const wrapper = readFileSync(join(import.meta.dirname, "../scripts/codemirror6-entry.js"), "utf8");
    const vendor = readPublicFile("vendor/codemirror/codemirror.js");

    expect(wrapper).toContain("EditorView.editorAttributes.of");
    expect(wrapper).toContain("EditorView.darkTheme.of(true)");
    expect(wrapper).toContain('"config-code-editor"');
    expect(wrapper).toContain('this.options.autoHeight ? "is-auto-height"');
    expect(wrapper).toContain('view.state.readOnly ? "is-readonly"');
    expect(app).toContain("autoHeight: Boolean(configCodeEditorMaxRows(textarea) || configCodeEditorRows(textarea))");
    expect(app).not.toContain('getWrapperElement().classList.add("config-code-editor")');
    expect(app).not.toContain('getWrapperElement().classList.toggle("is-auto-height"');
    expect(app).not.toContain('getWrapperElement().classList.toggle("is-readonly"');
    expect(vendor).toContain("config-code-editor");
    expect(vendor).toContain("is-auto-height");
    expect(vendor).toContain("is-readonly");
    expect(vendor).toContain("darkTheme.of(!0)");
  });
});
