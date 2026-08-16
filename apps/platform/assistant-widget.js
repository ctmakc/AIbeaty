/*
 * AIbeaty assistant widget — Maya chat launcher.
 *
 * Self-contained: no dependencies, no build step. Renders a floating chat
 * bubble that opens the Maya chat UI (served by the platform) in an iframe
 * inside a Shadow DOM panel.
 *
 * Contract (matches the landing placeholder 1:1):
 *   - Mount point: <div id="aibeaty-chat"></div> (falls back to document.body).
 *   - Config: window.AIBEATY_API_BASE = assistant API origin
 *     (e.g. "https://aibeaty.remolda.com"). Without it — silent no-op.
 *   - The chat page itself lives at {AIBEATY_API_BASE}/screens/chat.html.
 */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.AIBEATY_API_BASE) {
    return; // not configured — do nothing, render nothing
  }
  if (window.__aibeatyWidgetMounted) return;
  window.__aibeatyWidgetMounted = true;

  var API_BASE = String(window.AIBEATY_API_BASE).replace(/\/+$/, "");
  var CHAT_URL = API_BASE + "/screens/chat.html?embed=1";
  var API_ORIGIN;
  try { API_ORIGIN = new URL(API_BASE).origin; } catch (e) { return; }

  // --- UI locale (AIBEATY_L10N) ---
  // Maya mirrors the language of the guest's messages; the widget chrome follows
  // the browser: ru → Russian, uk → Ukrainian, anything else → English.
  // Labels and the teaser only — no layout, no logic.
  var AIBEATY_L10N = {
    ru: {
      panel: "Чат с Майей — ассистентом салона",
      open: "Открыть чат с Майей — ассистентом салона",
      minimize: "Свернуть чат с Майей",
      teaser: "Есть вопрос? Майя онлайн и ответит сразу.",
      hideTeaser: "Скрыть подсказку"
    },
    uk: {
      panel: "Чат з Майєю — асистентом салону",
      open: "Відкрити чат з Майєю — асистентом салону",
      minimize: "Згорнути чат з Майєю",
      teaser: "Є питання? Майя онлайн і відповість одразу.",
      hideTeaser: "Сховати підказку"
    },
    en: {
      panel: "Chat with Maya — the salon assistant",
      open: "Open chat with Maya, the salon assistant",
      minimize: "Minimize Maya chat",
      teaser: "Have a question? Maya is online and replies right away.",
      hideTeaser: "Dismiss hint"
    }
  };
  var LOCALE = (function () {
    var raw = "";
    try { raw = String(navigator.language || (navigator.languages && navigator.languages[0]) || ""); } catch (e) {}
    raw = raw.toLowerCase();
    if (raw.indexOf("ru") === 0) return "ru";
    if (raw.indexOf("uk") === 0) return "uk";
    return raw ? "en" : "ru";
  })();
  var T = AIBEATY_L10N[LOCALE];

  function boot() {
    var mount = document.getElementById("aibeaty-chat");
    if (!mount) {
      mount = document.createElement("div");
      mount.id = "aibeaty-chat";
      document.body.appendChild(mount);
    }
    var shadow = mount.attachShadow ? mount.attachShadow({ mode: "open" }) : mount;

    var style = document.createElement("style");
    style.textContent = [
      ":host { all: initial; }",
      "* { box-sizing: border-box; }",
      ".launcher {",
      "  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;",
      "  width: 60px; height: 60px; border-radius: 50%; border: none; cursor: pointer;",
      "  background: linear-gradient(135deg, #4d2afa, #7a25db); color: #ffffff;",
      "  display: flex; align-items: center; justify-content: center;",
      "  box-shadow: 0 6px 24px -6px rgba(77, 42, 250, 0.5), 0 2px 6px rgba(0,0,0,0.12);",
      "  transition: transform 180ms cubic-bezier(0.2, 0, 0, 1), box-shadow 180ms ease;",
      "}",
      ".launcher:hover { transform: translateY(-2px) scale(1.04); }",
      ".launcher:active { transform: scale(0.94); }",
      ".launcher:focus-visible { outline: 3px solid #c79eff; outline-offset: 3px; }",
      ".launcher svg { width: 26px; height: 26px; display: block; }",
      ".teaser {",
      "  position: fixed; right: 92px; bottom: 32px; z-index: 2147483000;",
      "  background: #ffffff; color: #2c2f30; border: 1px solid #dadddf;",
      "  font: 600 13px/1.35 Inter, system-ui, sans-serif;",
      "  padding: 10px 14px; border-radius: 14px; border-bottom-right-radius: 4px;",
      "  box-shadow: 0 6px 20px -8px rgba(20, 16, 60, 0.25); cursor: pointer;",
      "  display: flex; align-items: center; gap: 8px; max-width: 240px;",
      "  animation: aibeaty-teaser-in 260ms cubic-bezier(0.2, 0, 0, 1);",
      "}",
      ".teaser .x { border: none; background: none; cursor: pointer; color: #757778; font: inherit; padding: 0 2px; }",
      ".teaser .dot { width: 7px; height: 7px; border-radius: 50%; background: #2e6b4f; flex-shrink: 0; }",
      "@keyframes aibeaty-teaser-in { from { opacity: 0; transform: translateY(8px); } }",
      ".panel {",
      "  position: fixed; right: 20px; bottom: 92px; z-index: 2147483001;",
      "  width: 384px; height: min(640px, calc(100dvh - 112px));",
      "  border-radius: 16px; overflow: hidden; background: #f6f5fa;",
      "  border: 1px solid #dadddf;",
      "  box-shadow: 0 18px 48px -12px rgba(20, 16, 60, 0.35);",
      "  transform-origin: bottom right;",
      "  transition: transform 220ms cubic-bezier(0.2, 0, 0, 1), opacity 220ms ease;",
      "}",
      ".panel.hidden { transform: scale(0.92) translateY(10px); opacity: 0; pointer-events: none; }",
      ".panel iframe { width: 100%; height: 100%; border: 0; display: block; }",
      "@media (max-width: 560px) {",
      "  .panel { right: 0; bottom: 0; width: 100%; height: 100dvh; border-radius: 0; border: none; }",
      "  .panel:not(.hidden) ~ .launcher, .launcher.open-mobile { display: none; }",
      "}",
      "@media (prefers-reduced-motion: reduce) {",
      "  .launcher, .panel { transition: none; }",
      "  .teaser { animation: none; }",
      "}"
    ].join("\n");
    shadow.appendChild(style);

    var panel = document.createElement("div");
    panel.className = "panel hidden";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", T.panel);
    shadow.appendChild(panel);

    var launcher = document.createElement("button");
    launcher.type = "button";
    launcher.className = "launcher";
    launcher.setAttribute("aria-label", T.open);
    launcher.setAttribute("aria-expanded", "false");
    var chatIcon = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5c-5.52 0-10 3.7-10 8.27 0 2.6 1.45 4.92 3.72 6.44-.14.98-.55 2.19-1.5 3.13-.23.22-.06.61.26.58 1.9-.16 3.53-.9 4.66-1.62.9.24 1.87.37 2.86.37 5.52 0 10-3.7 10-8.27S17.52 2.5 12 2.5zM7.6 12.2a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6zm4.4 0a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6zm4.4 0a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6z"/></svg>';
    var closeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    launcher.innerHTML = chatIcon;
    shadow.appendChild(launcher);

    var open = false;
    var iframeLoaded = false;
    var teaser = null;

    function killTeaser() {
      if (teaser) { teaser.remove(); teaser = null; }
      try { sessionStorage.setItem("aibeaty.teaser", "1"); } catch (e) {}
    }

    function setOpen(next) {
      open = next;
      if (open && !iframeLoaded) {
        var iframe = document.createElement("iframe");
        iframe.src = CHAT_URL;
        iframe.title = T.panel;
        iframe.allow = "clipboard-write";
        panel.appendChild(iframe);
        iframeLoaded = true;
      }
      panel.classList.toggle("hidden", !open);
      launcher.classList.toggle("open-mobile", open);
      launcher.innerHTML = open ? closeIcon : chatIcon;
      launcher.setAttribute("aria-expanded", open ? "true" : "false");
      launcher.setAttribute("aria-label", open ? T.minimize : T.open);
      if (open) killTeaser();
    }

    launcher.addEventListener("click", function () { setOpen(!open); });

    window.addEventListener("message", function (event) {
      if (event.origin !== API_ORIGIN) return;
      var data = event.data;
      if (data && data.type === "aibeaty:close") setOpen(false);
    });
    window.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && open) setOpen(false);
    });

    // Gentle teaser, once per browser session.
    var teaserSeen = false;
    try { teaserSeen = sessionStorage.getItem("aibeaty.teaser") === "1"; } catch (e) {}
    if (!teaserSeen) {
      setTimeout(function () {
        if (open || teaser) return;
        teaser = document.createElement("div");
        teaser.className = "teaser";
        teaser.setAttribute("role", "status");
        teaser.innerHTML = '<span class="dot" aria-hidden="true"></span><span></span><button class="x" type="button">&#10005;</button>';
        teaser.children[1].textContent = T.teaser;
        teaser.children[2].setAttribute("aria-label", T.hideTeaser);
        teaser.addEventListener("click", function (event) {
          if (event.target && event.target.className === "x") { killTeaser(); return; }
          setOpen(true);
        });
        shadow.appendChild(teaser);
        setTimeout(function () { if (!open) killTeaser(); }, 12000);
      }, 2800);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
