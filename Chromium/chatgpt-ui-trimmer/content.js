/*
Filename: content.js
Purpose:
- Runs on ChatGPT pages and trims older conversation turns from the visible UI.
- Keeps only the last N turns visible (N configurable via popup).
- Adds a small status banner showing how many turns are hidden.
- Reapplies automatically when the page updates (new messages, React re-renders).
- Optionally enables a minimal UI mode (hide sidebar and some top actions).
- Optionally makes the user's own messages collapsible.
- Optionally makes code blocks collapsible.

Inputs:
- chrome.storage.sync settings:
  - keepLastN (number)
  - minimalUi (boolean)
  - collapseOwnMessages (boolean)
  - collapseCodeBlocks (boolean)

Outputs:
- DOM changes on the ChatGPT page (hidden older turns, banner, minimal UI)
- DOM changes for collapsible user messages and code blocks

Dependencies:
- manifest.json registers this as content script
- popup.js writes settings and sends commands

Processes:
- Find conversation turns using robust selectors
- Hide all but the last N turns
- Add collapse toggles for user messages and code blocks
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
    minimalUi: true,
    collapseOwnMessages: true,
    collapseCodeBlocks: true
  });

  const LIMITS = Object.freeze({
    minKeepLastN: 1,
    maxKeepLastN: 500
  });

  const TIMING = Object.freeze({
    applyDebounceMs: 120,
    initialApplyMs: 0,
    loadApplyMs: 50,
    visibleApplyMs: 80,
    storageApplyMs: 50
  });

  const SELECTORS = Object.freeze({
    conversationTurnsPrimary: 'article[data-testid^="conversation-turn-"]',
    conversationTurnsFallback: "article[data-turn-id][data-turn]",
    userRoleContainer: '[data-message-author-role="user"]',
    codeBlocks: "pre",
    threadRoot: "#thread",
    mainRoot: "main"
  });

  const IDS = Object.freeze({
    styleTag: "cgpt-trimmer-style",
    banner: "cgpt-trimmer-banner"
  });

  const CLASSES = Object.freeze({
    hiddenTurn: "cgpt-trimmer-hidden",
    minimalUi: "cgpt-trimmer-minimal-ui",
    messageToggle: "cgpt-trimmer-message-toggle",
    codeToggle: "cgpt-trimmer-code-toggle",
    collapsedUserMessage: "cgpt-trimmer-collapsed-user-message",
    collapsedCodeBlock: "cgpt-trimmer-collapsed-code-block"
  });

  const ATTRS = Object.freeze({
    messageKey: "data-cgpt-trimmer-message-key",
    codeKey: "data-cgpt-trimmer-code-key"
  });

  const LABELS = Object.freeze({
    showMyMessage: "Show my message",
    hideMyMessage: "Hide my message",
    showCode: "Show code",
    hideCode: "Hide code"
  });

  /**
   * Stores collapse states per message/code key so React re-renders do not reset user toggles.
   */
  const COLLAPSE_STATE = {
    messages: new Map(),
    codeBlocks: new Map()
  };

  let applyTimer = null;
  let observer = null;
  let listenersAttached = false;

  /**
   * Promise wrapper for chrome.storage.sync.get.
   * @returns {Promise<{keepLastN:number, minimalUi:boolean, collapseOwnMessages:boolean, collapseCodeBlocks:boolean}>}
   */
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULT_SETTINGS, (result) => {
        resolve({
          keepLastN: clampKeepLastN(result.keepLastN),
          minimalUi: Boolean(result.minimalUi),
          collapseOwnMessages: Boolean(result.collapseOwnMessages),
          collapseCodeBlocks: Boolean(result.collapseCodeBlocks)
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

    return Math.min(LIMITS.maxKeepLastN, Math.max(LIMITS.minKeepLastN, parsed));
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
      .${CLASSES.hiddenTurn} {
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

      .${CLASSES.messageToggle},
      .${CLASSES.codeToggle} {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin: 4px 0 6px 0;
        padding: 4px 8px;
        border-radius: 8px;
        border: 1px solid rgba(127, 127, 127, 0.35);
        background: rgba(127, 127, 127, 0.08);
        color: inherit;
        font-size: 11px;
        line-height: 1.2;
        cursor: pointer;
        user-select: none;
      }

      .${CLASSES.messageToggle}:hover,
      .${CLASSES.codeToggle}:hover {
        background: rgba(127, 127, 127, 0.14);
      }

      .${CLASSES.collapsedUserMessage} {
        display: none !important;
      }

      .${CLASSES.collapsedCodeBlock} {
        display: none !important;
      }

      html.${CLASSES.minimalUi} {
        --sidebar-width: 0px !important;
      }

      html.${CLASSES.minimalUi} #stage-slideover-sidebar {
        display: none !important;
        width: 0 !important;
        min-width: 0 !important;
        border: 0 !important;
      }

      html.${CLASSES.minimalUi} [data-testid="share-chat-button"],
      html.${CLASSES.minimalUi} [data-testid="conversation-options-button"] {
        display: none !important;
      }

      html.${CLASSES.minimalUi} [data-skip-to-content] {
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
    let turns = Array.from(document.querySelectorAll(SELECTORS.conversationTurnsPrimary));

    if (turns.length === 0) {
      turns = Array.from(document.querySelectorAll(SELECTORS.conversationTurnsFallback));
    }

    const threadRoot = document.querySelector(SELECTORS.threadRoot);
    if (threadRoot) {
      turns = turns.filter((element) => threadRoot.contains(element));
    }

    return turns.filter((element) => element instanceof HTMLElement);
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

    banner.textContent = `${hiddenCount} older messages hidden. Showing the last ${keepLastN} turns (${totalCount} total).`;
  }

  /**
   * Hides or shows one conversation turn.
   * @param {HTMLElement} turn
   * @param {boolean} hidden
   */
  function setTurnHidden(turn, hidden) {
    turn.classList.toggle(CLASSES.hiddenTurn, hidden);

    if (hidden) {
      turn.setAttribute("data-cgpt-trimmer-hidden", "1");
      return;
    }

    turn.removeAttribute("data-cgpt-trimmer-hidden");
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
    document.documentElement.classList.toggle(CLASSES.minimalUi, enabled);
  }

  /**
   * Returns a stable key for a turn to preserve collapse state across re-renders.
   * @param {HTMLElement} turn
   * @param {number} index
   * @returns {string}
   */
  function getTurnKey(turn, index) {
    const testId = turn.getAttribute("data-testid");
    const turnId = turn.getAttribute("data-turn-id");
    const genericTurn = turn.getAttribute("data-turn");

    if (testId) {
      return testId;
    }

    if (turnId) {
      return `turn-id:${turnId}`;
    }

    if (genericTurn) {
      return `turn:${genericTurn}`;
    }

    return `turn-index:${index}`;
  }

  /**
   * Finds the user message container inside a turn.
   * This is the node that gets hidden/shown when collapsing "my message".
   * @param {HTMLElement} turn
   * @returns {HTMLElement|null}
   */
  function findUserMessageNode(turn) {
    const node = turn.querySelector(SELECTORS.userRoleContainer);
    return node instanceof HTMLElement ? node : null;
  }

  /**
   * Finds a child button by CSS class and a matching data attribute value.
   * @param {ParentNode} root
   * @param {string} className
   * @param {string} attributeName
   * @param {string} key
   * @returns {HTMLButtonElement|null}
   */
  function findChildButtonByKey(root, className, attributeName, key) {
    const buttons = root.querySelectorAll(`button.${className}`);

    for (const button of buttons) {
      if (!(button instanceof HTMLButtonElement)) {
        continue;
      }

      if (button.getAttribute(attributeName) === key) {
        return button;
      }
    }

    return null;
  }

  /**
   * Updates the collapsed state and label for a user message.
   * @param {HTMLElement} messageNode
   * @param {HTMLButtonElement} button
   * @param {boolean} collapsed
   */
  function setMessageCollapsed(messageNode, button, collapsed) {
    messageNode.classList.toggle(CLASSES.collapsedUserMessage, collapsed);
    button.setAttribute("aria-expanded", String(!collapsed));
    button.textContent = collapsed ? LABELS.showMyMessage : LABELS.hideMyMessage;
  }

  /**
   * Ensures a collapse toggle exists for a user message and applies the current state.
   * @param {HTMLElement} turn
   * @param {HTMLElement} messageNode
   * @param {string} messageKey
   */
  function ensureMessageToggle(turn, messageNode, messageKey) {
    const host = messageNode.parentElement || turn;
    let button = findChildButtonByKey(turn, CLASSES.messageToggle, ATTRS.messageKey, messageKey);

    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = CLASSES.messageToggle;
      button.setAttribute(ATTRS.messageKey, messageKey);

      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();

        const current = COLLAPSE_STATE.messages.get(messageKey) === true;
        const next = !current;

        COLLAPSE_STATE.messages.set(messageKey, next);
        setMessageCollapsed(messageNode, button, next);
      });
    }

    if (button.parentElement !== host || button.nextSibling !== messageNode) {
      host.insertBefore(button, messageNode);
    }

    if (!COLLAPSE_STATE.messages.has(messageKey)) {
      COLLAPSE_STATE.messages.set(messageKey, true);
    }

    setMessageCollapsed(messageNode, button, COLLAPSE_STATE.messages.get(messageKey) === true);
  }

  /**
   * Removes all user-message collapse UI and restores message visibility.
   */
  function cleanupMessageCollapsers() {
    const buttons = document.querySelectorAll(`button.${CLASSES.messageToggle}`);
    for (const button of buttons) {
      button.remove();
    }

    const nodes = document.querySelectorAll(`.${CLASSES.collapsedUserMessage}`);
    for (const node of nodes) {
      node.classList.remove(CLASSES.collapsedUserMessage);
    }
  }

  /**
   * Applies collapsible toggles for user messages.
   * @param {HTMLElement[]} turns
   * @param {boolean} enabled
   */
  function applyMessageCollapsers(turns, enabled) {
    if (!enabled) {
      cleanupMessageCollapsers();
      return;
    }

    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index];
      const messageNode = findUserMessageNode(turn);

      if (!messageNode) {
        continue;
      }

      const messageKey = `${getTurnKey(turn, index)}::user-message`;
      ensureMessageToggle(turn, messageNode, messageKey);
    }
  }

  /**
   * Updates the collapsed state and label for a code block.
   * Only the <pre> is hidden, so copy buttons in the code header keep working.
   * @param {HTMLElement} preElement
   * @param {HTMLButtonElement} button
   * @param {boolean} collapsed
   */
  function setCodeCollapsed(preElement, button, collapsed) {
    preElement.classList.toggle(CLASSES.collapsedCodeBlock, collapsed);
    button.setAttribute("aria-expanded", String(!collapsed));
    button.textContent = collapsed ? LABELS.showCode : LABELS.hideCode;
  }

  /**
   * Ensures a collapse toggle exists for a code block and applies the current state.
   * @param {HTMLElement} preElement
   * @param {string} codeKey
   */
  function ensureCodeToggle(preElement, codeKey) {
    const host = preElement.parentElement;
    if (!host) {
      return;
    }

    let button = findChildButtonByKey(host, CLASSES.codeToggle, ATTRS.codeKey, codeKey);

    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = CLASSES.codeToggle;
      button.setAttribute(ATTRS.codeKey, codeKey);

      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();

        const current = COLLAPSE_STATE.codeBlocks.get(codeKey) === true;
        const next = !current;

        COLLAPSE_STATE.codeBlocks.set(codeKey, next);
        setCodeCollapsed(preElement, button, next);
      });
    }

    if (button.parentElement !== host || button.nextSibling !== preElement) {
      host.insertBefore(button, preElement);
    }

    if (!COLLAPSE_STATE.codeBlocks.has(codeKey)) {
      COLLAPSE_STATE.codeBlocks.set(codeKey, true);
    }

    setCodeCollapsed(preElement, button, COLLAPSE_STATE.codeBlocks.get(codeKey) === true);
  }

  /**
   * Removes all code collapse UI and restores code visibility.
   */
  function cleanupCodeCollapsers() {
    const buttons = document.querySelectorAll(`button.${CLASSES.codeToggle}`);
    for (const button of buttons) {
      button.remove();
    }

    const nodes = document.querySelectorAll(`.${CLASSES.collapsedCodeBlock}`);
    for (const node of nodes) {
      node.classList.remove(CLASSES.collapsedCodeBlock);
    }
  }

  /**
   * Applies collapsible toggles for code blocks.
   * @param {HTMLElement[]} turns
   * @param {boolean} enabled
   */
  function applyCodeCollapsers(turns, enabled) {
    if (!enabled) {
      cleanupCodeCollapsers();
      return;
    }

    for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
      const turn = turns[turnIndex];
      const turnKey = getTurnKey(turn, turnIndex);
      const preBlocks = turn.querySelectorAll(SELECTORS.codeBlocks);

      let codeIndex = 0;

      for (const preBlock of preBlocks) {
        if (!(preBlock instanceof HTMLElement)) {
          continue;
        }

        const codeKey = `${turnKey}::code-block:${codeIndex}`;
        ensureCodeToggle(preBlock, codeKey);
        codeIndex += 1;
      }
    }
  }

  /**
   * Applies all optional collapsible features.
   * @param {HTMLElement[]} turns
   * @param {{collapseOwnMessages:boolean, collapseCodeBlocks:boolean}} settings
   */
  function applyCollapsibleFeatures(turns, settings) {
    applyMessageCollapsers(turns, settings.collapseOwnMessages);
    applyCodeCollapsers(turns, settings.collapseCodeBlocks);
  }

  /**
   * Applies trimming and optional UI features based on current settings.
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

    for (let index = 0; index < turns.length; index += 1) {
      const shouldHide = index < hiddenCount;
      setTurnHidden(turns[index], shouldHide);
    }

    applyCollapsibleFeatures(turns, settings);
    updateBanner(hiddenCount, turns.length, settings.keepLastN, turns);

    return {
      ok: true,
      hiddenCount,
      totalCount: turns.length,
      keepLastN: settings.keepLastN
    };
  }

  /**
   * Debounced apply to reduce flicker during streaming and React re-renders.
   * @param {number} delayMs
   */
  function scheduleApply(delayMs = TIMING.applyDebounceMs) {
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
          scheduleApply(TIMING.applyDebounceMs);
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
   * Adds global listeners used to preserve usability when a user message is collapsed.
   * If the user clicks any non-toggle button inside a collapsed user turn, the turn is auto-expanded first.
   */
  function attachGlobalListeners() {
    if (listenersAttached) {
      return;
    }

    listenersAttached = true;

    document.addEventListener(
      "click",
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
          return;
        }

        if (target.closest(`button.${CLASSES.messageToggle}`)) {
          return;
        }

        const turn = target.closest("article");
        if (!(turn instanceof HTMLElement)) {
          return;
        }

        const messageNode = findUserMessageNode(turn);
        if (!messageNode) {
          return;
        }

        if (!messageNode.classList.contains(CLASSES.collapsedUserMessage)) {
          return;
        }

        const button = turn.querySelector(`button.${CLASSES.messageToggle}`);
        if (!(button instanceof HTMLButtonElement)) {
          return;
        }

        const messageKey = button.getAttribute(ATTRS.messageKey);
        if (messageKey) {
          COLLAPSE_STATE.messages.set(messageKey, false);
        }

        setMessageCollapsed(messageNode, button, false);
      },
      true
    );
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
        minimalUi: Boolean(message.minimalUi),
        collapseOwnMessages: Boolean(message.collapseOwnMessages),
        collapseCodeBlocks: Boolean(message.collapseCodeBlocks)
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
      const hiddenCount = turns.filter((turn) => turn.classList.contains(CLASSES.hiddenTurn)).length;

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
    attachGlobalListeners();
    startObserver();

    scheduleApply(TIMING.initialApplyMs);

    window.addEventListener("load", () => scheduleApply(TIMING.loadApplyMs), { once: true });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        scheduleApply(TIMING.visibleApplyMs);
      }
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync") {
        return;
      }

      if (
        "keepLastN" in changes ||
        "minimalUi" in changes ||
        "collapseOwnMessages" in changes ||
        "collapseCodeBlocks" in changes
      ) {
        scheduleApply(TIMING.storageApplyMs);
      }
    });
  }

  init();
})();