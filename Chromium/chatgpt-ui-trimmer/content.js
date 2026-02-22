/*
Filename: content.js
Purpose:
- Runs on ChatGPT pages and trims older conversation turns from the visible UI.
- Keeps only the last N turns visible (N configurable via popup).
- Adds a small status banner showing how many turns are hidden.
- Reapplies automatically when the page updates (new messages, React re-renders).
- Optionally enables a minimal UI mode (hide sidebar and some top actions).

Inputs:
- chrome.storage.sync settings:
  - keepLastN (number)
  - minimalUi (boolean)

Outputs:
- DOM changes on the ChatGPT page (hidden older turns, banner, minimal UI)

Dependencies:
- manifest.json registers this as content script
- popup.js writes settings and sends commands

Processes:
- Find conversation turns using robust selectors
- Hide all but the last N turns
- Watch DOM changes with MutationObserver
- Respond to popup commands

AI-Instructions:
- When editing this file, always output drop-in code (no diff markers, no +/- lines).
- Always include the filename and full updated declarations in the response.
- Keep this code as simple as possible. Comment everything perfectly understandable
- Prefer Config-Class values over literals; ask if a new constant is needed.
*/

(() => {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    keepLastN: 6,
    minimalUi: true
  });

  const SELECTORS = Object.freeze({
    conversationTurnsPrimary: 'article[data-testid^="conversation-turn-"]',
    conversationTurnsFallback: "article[data-turn-id][data-turn]",
    threadRoot: "#thread",
    mainRoot: "main"
  });

  const IDS = Object.freeze({
    styleTag: "cgpt-trimmer-style",
    banner: "cgpt-trimmer-banner"
  });

  let applyTimer = null;
  let observer = null;

  /**
   * Promise wrapper for chrome.storage.sync.get.
   * @returns {Promise<{keepLastN:number, minimalUi:boolean}>}
   */
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULT_SETTINGS, (result) => {
        resolve({
          keepLastN: clampKeepLastN(result.keepLastN),
          minimalUi: Boolean(result.minimalUi)
        });
      });
    });
  }

  /**
   * Promise wrapper for chrome.storage.sync.set.
   * @param {object} value
   * @returns {Promise<void>}
   */
  function saveSettings(value) {
    return new Promise((resolve) => {
      chrome.storage.sync.set(value, () => resolve());
    });
  }

  /**
   * Clamp visible turn count to a sane range.
   * @param {unknown} value
   * @returns {number}
   */
  function clampKeepLastN(value) {
    const parsed = Number.parseInt(String(value), 10);

    if (!Number.isFinite(parsed)) {
      return DEFAULT_SETTINGS.keepLastN;
    }

    return Math.min(500, Math.max(1, parsed));
  }

  /**
   * Injects extension CSS once.
   */
  function ensureStyleTag() {
    if (document.getElementById(IDS.styleTag)) {
      return;
    }

    const style = document.createElement("style");
    style.id = IDS.styleTag;
    style.textContent = `
      .cgpt-trimmer-hidden {
        display: none !important;
      }

      #${IDS.banner} {
        margin: 8px auto 12px auto;
        padding: 8px 12px;
        max-width: 48rem;
        border-radius: 10px;
        border: 1px solid rgba(127, 127, 127, 0.35);
        background: rgba(127, 127, 127, 0.08);
        color: inherit;
        font-size: 12px;
        line-height: 1.35;
        opacity: 0.9;
      }

      html.cgpt-trimmer-minimal-ui {
        --sidebar-width: 0px !important;
      }

      html.cgpt-trimmer-minimal-ui #stage-slideover-sidebar {
        display: none !important;
        width: 0 !important;
        min-width: 0 !important;
        border: 0 !important;
      }

      html.cgpt-trimmer-minimal-ui [data-testid="share-chat-button"],
      html.cgpt-trimmer-minimal-ui [data-testid="conversation-options-button"] {
        display: none !important;
      }

      html.cgpt-trimmer-minimal-ui [data-skip-to-content] {
        display: none !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  /**
   * Returns the best available list of conversation turn <article> elements.
   * @returns {HTMLElement[]}
   */
  function getConversationTurns() {
    let turns = Array.from(
      document.querySelectorAll(SELECTORS.conversationTurnsPrimary)
    );

    if (turns.length === 0) {
      turns = Array.from(document.querySelectorAll(SELECTORS.conversationTurnsFallback));
    }

    const threadRoot = document.querySelector(SELECTORS.threadRoot);
    if (threadRoot) {
      turns = turns.filter((el) => threadRoot.contains(el));
    }

    return turns.filter((el) => el instanceof HTMLElement);
  }

  /**
   * Finds a suitable parent container for the status banner.
   * @param {HTMLElement[]} turns
   * @returns {HTMLElement|null}
   */
  function getBannerHost(turns) {
    if (turns.length > 0 && turns[0].parentElement) {
      return turns[0].parentElement;
    }

    const threadRoot = document.querySelector(SELECTORS.threadRoot);
    if (threadRoot instanceof HTMLElement) {
      return threadRoot;
    }

    const mainRoot = document.querySelector(SELECTORS.mainRoot);
    if (mainRoot instanceof HTMLElement) {
      return mainRoot;
    }

    return document.body instanceof HTMLElement ? document.body : null;
  }

  /**
   * Removes the status banner if present.
   */
  function removeBanner() {
    const existing = document.getElementById(IDS.banner);
    if (existing) {
      existing.remove();
    }
  }

  /**
   * Updates or creates the small banner that shows trim status.
   * @param {number} hiddenCount
   * @param {number} totalCount
   * @param {number} keepLastN
   * @param {HTMLElement[]} turns
   */
  function updateBanner(hiddenCount, totalCount, keepLastN, turns) {
    if (hiddenCount <= 0) {
      removeBanner();
      return;
    }

    const host = getBannerHost(turns);
    if (!host) {
      return;
    }

    let banner = document.getElementById(IDS.banner);
    if (!banner) {
      banner = document.createElement("div");
      banner.id = IDS.banner;
      banner.setAttribute("role", "status");
      banner.setAttribute("aria-live", "polite");

      if (turns.length > 0) {
        host.insertBefore(banner, turns[0]);
      } else {
        host.prepend(banner);
      }
    }

    banner.textContent =
      `${hiddenCount} older messages hidden. ` +
      `Showing the last ${keepLastN} turns (${totalCount} total).`;
  }

  /**
   * Hides or shows one conversation turn.
   * @param {HTMLElement} turn
   * @param {boolean} hidden
   */
  function setTurnHidden(turn, hidden) {
    turn.classList.toggle("cgpt-trimmer-hidden", hidden);

    if (hidden) {
      turn.setAttribute("data-cgpt-trimmer-hidden", "1");
    } else {
      turn.removeAttribute("data-cgpt-trimmer-hidden");
    }
  }

  /**
   * Shows all conversation turns immediately.
   */
  function showAllTurns() {
    const turns = getConversationTurns();
    for (const turn of turns) {
      setTurnHidden(turn, false);
    }
    removeBanner();
  }

  /**
   * Applies minimal UI toggles.
   * @param {boolean} enabled
   */
  function applyMinimalUi(enabled) {
    document.documentElement.classList.toggle("cgpt-trimmer-minimal-ui", enabled);
  }

  /**
   * Applies trimming based on current settings.
   * @returns {Promise<{ok:true, hiddenCount:number, totalCount:number, keepLastN:number}>}
   */
  async function applyTrimming() {
    ensureStyleTag();

    const settings = await loadSettings();
    const turns = getConversationTurns();

    applyMinimalUi(settings.minimalUi);

    if (turns.length === 0) {
      removeBanner();
      return {
        ok: true,
        hiddenCount: 0,
        totalCount: 0,
        keepLastN: settings.keepLastN
      };
    }

    const hiddenCount = Math.max(0, turns.length - settings.keepLastN);

    for (let i = 0; i < turns.length; i += 1) {
      const shouldHide = i < hiddenCount;
      setTurnHidden(turns[i], shouldHide);
    }

    updateBanner(hiddenCount, turns.length, settings.keepLastN, turns);

    return {
      ok: true,
      hiddenCount,
      totalCount: turns.length,
      keepLastN: settings.keepLastN
    };
  }

  /**
   * Debounced apply to reduce flicker during streaming/re-renders.
   * @param {number} delayMs
   */
  function scheduleApply(delayMs = 120) {
    window.clearTimeout(applyTimer);
    applyTimer = window.setTimeout(() => {
      applyTrimming().catch((error) => {
        console.error("[ChatGPT UI Trimmer] applyTrimming failed:", error);
      });
    }, delayMs);
  }

  /**
   * Starts a MutationObserver to re-apply trimming on UI changes.
   */
  function startObserver() {
    if (observer) {
      return;
    }

    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          scheduleApply(120);
          return;
        }
      }
    });

    const root = document.documentElement || document.body;
    if (!root) {
      return;
    }

    observer.observe(root, {
      childList: true,
      subtree: true
    });
  }

  /**
   * Handles messages from popup.js.
   */
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "TRIMMER_APPLY") {
      const nextSettings = {
        keepLastN: clampKeepLastN(message.keepLastN),
        minimalUi: Boolean(message.minimalUi)
      };

      saveSettings(nextSettings)
        .then(() => applyTrimming())
        .then((result) => sendResponse(result))
        .catch((error) => {
          sendResponse({
            ok: false,
            error: String(error)
          });
        });

      return true;
    }

    if (message.type === "TRIMMER_SHOW_ALL") {
      showAllTurns();
      sendResponse({
        ok: true,
        hiddenCount: 0
      });
      return;
    }

    if (message.type === "TRIMMER_STATUS") {
      const turns = getConversationTurns();
      const hiddenCount = turns.filter((turn) =>
        turn.classList.contains("cgpt-trimmer-hidden")
      ).length;

      sendResponse({
        ok: true,
        totalCount: turns.length,
        hiddenCount
      });
      return;
    }
  });

  /**
   * Initializes the content script.
   */
  function init() {
    ensureStyleTag();
    startObserver();

    scheduleApply(0);

    window.addEventListener("load", () => scheduleApply(50), { once: true });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        scheduleApply(80);
      }
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync") {
        return;
      }

      if ("keepLastN" in changes || "minimalUi" in changes) {
        scheduleApply(50);
      }
    });
  }

  init();
})();