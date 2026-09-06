import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, Decoration, ViewPlugin, keymap } from "@codemirror/view";
import { indentMore } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { basicSetup } from "codemirror";

const CONFIG_PROXY_PARAM_KEY_PATTERN = /(?:server|port|password|username|sni|peer|host|interface|routing-mark|underlying-proxy|subnet|test-url|interval|timeout|policy-path|update-interval|icon|include-all|hidden|no-alert|smart|url|tfo|udp|skip-cert-verify|ws|ws-path|ws-headers|obfs|obfs-host|obfs-uri|amux|protocol|protocol-param|section-name|client-id|private-key|public-key|pre-shared-key|reserved|mtu|keepalive|ip-version|tls|servername|alpn|fingerprint|reality-opts|ech|shadow-tls-password|shadow-tls-version|version|mode|reuse|allow-other-interface|prefer-ipv6|include-other-group|policy-regex-filter|evaluate-before-use|external-policy-modifier|src-ip|dst-port|in-port|process-name|lookup|server-cert-fingerprint-sha256|proxy|type|script-path|max-size|body-required|argument)(?=\s*[=:])/i;
const CONFIG_PROXY_PROTOCOL_PATTERN = /(?:shadowsocks|ss|ssr|vmess|vless|trojan|tuic|hysteria2?|wireguard|snell|http|https|socks5?|direct|reject|url-test|fallback|load-balance|select|ssid|subnet)(?=\s*,|\s|$)/i;
const CONFIG_IPV4_PATTERN = /(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?=\b|\/)/;
const CONFIG_IPV4_CIDR_PATTERN = /(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\/(?:3[0-2]|[12]?\d)(?=\b|,|\s|$)/;
const CONFIG_NUMBER_PATTERN = /(?:\b\d+(?:\.\d+)?)(?=\b|,|\s|$)/;
const CONFIG_BARE_VALUE_PATTERN = /[^,\s#;][^,#;]*/;

class LineStream {
  constructor(string) {
    this.string = string;
    this.pos = 0;
  }

  sol() {
    return this.pos === 0;
  }

  peek() {
    return this.string.charAt(this.pos) || undefined;
  }

  next() {
    return this.string.charAt(this.pos++) || undefined;
  }

  eatSpace() {
    const match = /\s+/.exec(this.string.slice(this.pos));
    if (!match || match.index !== 0) return false;
    this.pos += match[0].length;
    return true;
  }

  skipToEnd() {
    this.pos = this.string.length;
  }

  match(pattern, consume = true) {
    if (typeof pattern === "string") {
      if (!this.string.startsWith(pattern, this.pos)) return false;
      if (consume) this.pos += pattern.length;
      return true;
    }
    const match = pattern.exec(this.string.slice(this.pos));
    if (!match || match.index !== 0) return false;
    if (consume) this.pos += match[0].length;
    return true;
  }
}

function policyCandidates(provider) {
  try {
    const value = typeof provider === "function" ? provider() : provider;
    return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function hasConfigPolicyBoundary(stream) {
  const next = stream.peek();
  return !next || /[,\s\])]/.test(next);
}

function hasConfigPolicyStartBoundary(stream) {
  const previous = stream.pos > 0 ? stream.string.charAt(stream.pos - 1) : "";
  return !previous || /[,\s([=]/.test(previous);
}

function hasConfigTokenStartBoundary(stream) {
  const previous = stream.pos > 0 ? stream.string.charAt(stream.pos - 1) : "";
  return !previous || /[,\s([{:]/.test(previous);
}

function matchConfigPolicyToken(stream, policies) {
  if (!hasConfigPolicyStartBoundary(stream)) return false;
  for (const policy of policies) {
    const start = stream.pos;
    if (stream.match(policy)) {
      if (hasConfigPolicyBoundary(stream)) return true;
      stream.pos = start;
    }
  }
  return Boolean(
    stream.match(/(?:DIRECT|Proxy|REJECT(?:-(?:DROP|NO-DROP|TINYGIF))?|PASS|GLOBAL)(?=\s*,|\s|\]|\)|$)/i)
  );
}

function matchConfigProxyParamKey(stream) {
  return hasConfigTokenStartBoundary(stream) && Boolean(stream.match(CONFIG_PROXY_PARAM_KEY_PATTERN));
}

function matchConfigProxyProtocol(stream) {
  return hasConfigTokenStartBoundary(stream) && Boolean(stream.match(CONFIG_PROXY_PROTOCOL_PATTERN));
}

function configToken(stream, parserState, policies) {
  const resetProxyParamState = () => {
    parserState.afterProxyParamKey = false;
    parserState.afterProxyParamOperator = false;
  };
  if (stream.sol()) resetProxyParamState();
  if (stream.sol() && stream.match(/\s*[#;]/, false)) {
    stream.skipToEnd();
    return "comment";
  }
  if (stream.eatSpace()) return null;
  if (stream.match(/[;#].*/)) {
    resetProxyParamState();
    return "comment";
  }
  if (parserState.afterProxyParamKey && !/[=:]/.test(stream.peek() || "")) {
    parserState.afterProxyParamKey = false;
  }
  if (parserState.afterProxyParamOperator) {
    parserState.afterProxyParamOperator = false;
    if (stream.match(/"(?:[^"\\]|\\.)*"/) || stream.match(/'(?:[^'\\]|\\.)*'/)) return "string";
    if (stream.match(/[^,\s#;][^,#;]*/)) return "string";
  }
  if (stream.match(/\[[^\]]+\]/)) return "header";
  if (stream.match(/"(?:[^"\\]|\\.)*"/) || stream.match(/'(?:[^'\\]|\\.)*'/)) return "string";
  if (stream.match(/https?:\/\/[^\s,]+/i)) return "link";
  if (matchConfigProxyParamKey(stream)) {
    parserState.afterProxyParamKey = true;
    return "attribute";
  }
  if (stream.match(/[A-Za-z][\w.-]*(?=\s*:)/)) return "attribute";
  if (matchConfigProxyProtocol(stream)) return "keyword";
  if (stream.match(/(?:RULE-SET|DOMAIN-SET|DOMAIN-SUFFIX|DOMAIN-KEYWORD|DOMAIN-WILDCARD|DOMAIN|IP-CIDR6?|GEOIP|FINAL|URL-REGEX|PROCESS-NAME|SUBNET|AND|OR|NOT|SSID|BSSID|ROUTER|TYPE|DEVICE-NAME)(?=\s*,|\s|$)/i)) return "keyword";
  if (matchConfigPolicyToken(stream, policies)) return "variable-2";
  if (stream.match(/(?:no-resolve|extended-matching|server:[^,\s]+|skip-server-cert-verify|ca-passphrase|ca-p12|hostname|h2)(?=\s*,|\s|=|$)/i)) return "attribute";
  const operator = stream.peek();
  if (operator && /[=,:]/.test(operator)) {
    stream.next();
    parserState.afterProxyParamOperator = parserState.afterProxyParamKey && /[=:]/.test(operator);
    parserState.afterProxyParamKey = false;
    return "operator";
  }
  if (stream.match(CONFIG_IPV4_CIDR_PATTERN)) return "number";
  if (stream.match(CONFIG_IPV4_PATTERN)) return "number";
  if (stream.match(CONFIG_NUMBER_PATTERN)) return "number";
  if (stream.match(CONFIG_BARE_VALUE_PATTERN)) return "string";
  stream.next();
  return null;
}

function proxyConfigDecorations(view, provider) {
  const ranges = [];
  const policies = policyCandidates(provider);
  for (const visibleRange of view.visibleRanges) {
    let line = view.state.doc.lineAt(visibleRange.from);
    while (line.from <= visibleRange.to) {
      const stream = new LineStream(line.text);
      const parserState = {
        afterProxyParamKey: false,
        afterProxyParamOperator: false
      };
      while (stream.pos < stream.string.length) {
        const start = stream.pos;
        const tokenClass = configToken(stream, parserState, policies);
        const end = stream.pos;
        if (end <= start) {
          stream.next();
          continue;
        }
        if (tokenClass) {
          ranges.push(Decoration.mark({ class: `cm-${tokenClass}` }).range(line.from + start, line.from + end));
        }
      }
      if (line.to >= view.state.doc.length) break;
      line = view.state.doc.line(line.number + 1);
    }
  }
  return Decoration.set(ranges, true);
}

function proxyConfigHighlighter(provider) {
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.decorations = proxyConfigDecorations(view, provider);
    }

    update(update) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = proxyConfigDecorations(update.view, provider);
      }
    }
  }, {
    decorations: (plugin) => plugin.decorations
  });
}

function readOnlyExtensions(readOnly) {
  return [
    EditorState.readOnly.of(Boolean(readOnly)),
    EditorView.editable.of(!readOnly)
  ];
}

class SubPilotCodeEditor {
  constructor(textarea, options = {}) {
    this.textarea = textarea;
    this.options = { ...options };
    this.changeHandlers = [];
    this.subpilotSyncing = false;
    this.readOnlyCompartment = new Compartment();
    this.modeCompartment = new Compartment();
    this.host = document.createElement("div");
    textarea.style.display = "none";
    textarea.after(this.host);

    this.view = new EditorView({
      state: EditorState.create({
        doc: textarea.value || "",
        extensions: [
          basicSetup,
          EditorState.tabSize.of(Number(options.tabSize) || 2),
          indentUnit.of(" ".repeat(Number(options.indentUnit) || 2)),
          options.lineWrapping === false ? [] : EditorView.lineWrapping,
          EditorView.darkTheme.of(true),
          EditorView.editorAttributes.of((view) => ({
            class: [
              "config-code-editor",
              this.options.autoHeight ? "is-auto-height" : "",
              view.state.readOnly ? "is-readonly" : ""
            ].filter(Boolean).join(" ")
          })),
          this.readOnlyCompartment.of(readOnlyExtensions(options.readOnly)),
          this.modeCompartment.of(this.modeExtensions(options.mode)),
          keymap.of([
            {
              key: "Tab",
              run: (view) => {
                if (view.state.selection.ranges.some((range) => !range.empty)) return indentMore(view);
                view.dispatch(view.state.replaceSelection(" ".repeat(Number(this.options.indentUnit) || 2)));
                return true;
              }
            },
          ]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || this.subpilotSyncing) return;
            for (const handler of this.changeHandlers) handler(this);
          })
        ]
      }),
      parent: this.host
    });
  }

  modeExtensions(mode) {
    if (mode !== "proxy-config") return [];
    return [proxyConfigHighlighter(this.options.policyTokens)];
  }

  getValue() {
    return this.view.state.doc.toString();
  }

  setValue(value) {
    const text = String(value ?? "");
    this.view.dispatch({
      changes: {
        from: 0,
        to: this.view.state.doc.length,
        insert: text
      }
    });
  }

  save() {
    this.textarea.value = this.getValue();
  }

  getOption(name) {
    return this.options[name];
  }

  setOption(name, value) {
    this.options[name] = value;
    if (name === "readOnly") {
      this.view.dispatch({
        effects: this.readOnlyCompartment.reconfigure(readOnlyExtensions(value))
      });
      return;
    }
    if (name === "mode") {
      this.view.dispatch({
        effects: this.modeCompartment.reconfigure(this.modeExtensions(value))
      });
    }
  }

  getWrapperElement() {
    return this.view.dom;
  }

  on(eventName, handler) {
    if (eventName === "change" && typeof handler === "function") this.changeHandlers.push(handler);
  }

  refresh() {
    if (this.options.mode === "proxy-config") {
      this.view.dispatch({
        effects: this.modeCompartment.reconfigure(this.modeExtensions(this.options.mode))
      });
    }
    this.view.requestMeasure();
  }

  setSize(width, height) {
    if (width != null) this.view.dom.style.width = typeof width === "number" ? `${width}px` : String(width);
    if (height != null) this.view.dom.style.height = typeof height === "number" ? `${height}px` : String(height);
  }

  lastLine() {
    return this.view.state.doc.lines;
  }

  heightAtLine(lineNumber) {
    if (!Number.isFinite(lineNumber) || lineNumber > this.view.state.doc.lines) return this.view.contentHeight;
    const line = this.view.state.doc.line(Math.max(1, lineNumber));
    return this.view.lineBlockAt(line.to).bottom;
  }

  somethingSelected() {
    return this.view.state.selection.ranges.some((range) => !range.empty);
  }

  replaceSelection(text) {
    this.view.dispatch(this.view.state.replaceSelection(String(text ?? "")));
    this.view.focus();
  }

  indentSelection() {
    indentMore(this.view);
  }

  destroy() {
    this.view.destroy();
    this.host.remove();
    this.textarea.style.display = "";
  }
}

window.SubPilotCodeMirror = {
  version: "6",
  fromTextArea(textarea, options) {
    return new SubPilotCodeEditor(textarea, options);
  }
};
