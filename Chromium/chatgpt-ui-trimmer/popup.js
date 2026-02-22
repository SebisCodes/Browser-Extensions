/*
Filename: popup.js
Purpose:
- Controls the popup UI for the ChatGPT UI Trimmer extension.
- Loads and saves user settings from chrome.storage.sync.
- Sends commands to the content script in the active tab.
- Exposes checkboxes for collapsible user messages and collapsible code blocks.

Inputs:
- Popup form values:
  - keepLastN
  - minimalUi
  - collapseOwnMessages
  - collapseCodeBlocks

Outputs:
- Messages to content.js
- Status text in popup

Dependencies:
- popup.html
- content.js
- chrome.storage.sync
- chrome.tabs messaging

Processes:
- Read current settings
- Apply settings to active ChatGPT tab
- Show all hidden turns
- Reset defaults

AI-Instructions:
- When editing this file, always output drop-in code (no diff markers, no +/- lines).
- Always include the filename and full updated declarations in the response.
- Keep this code as simple as possible. Comment everything perfectly understandable
- Prefer Config-Class values over literals; ask if a new constant is needed.
*/

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
 * Get the active tab in the current window.
 * @returns {Promise<chrome.tabs.Tab | null>}
 */
function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0] || null);
    });
  });
}

/**
 * Sends a message to the content script in the active tab.
 * @param {object} message
 * @returns {Promise<any>}
 */
async function sendMessageToActiveTab(message) {
  const tab = await getActiveTab();

  if (!tab || typeof tab.id !== "number") {
    throw new Error("No active tab found.");
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, message, (response) => {
      const lastError = chrome.runtime.lastError;

      if (lastError) {
        reject(
          new Error("Content script is not reachable. Open a ChatGPT tab and reload the page.")
        );
        return;
      }

      resolve(response);
    });
  });
}

/**
 * Clamps the turn count to a sane range.
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
 * Updates popup status text.
 * @param {string} text
 * @param {boolean} isError
 */
function setStatus(text, isError = false) {
  const status = document.getElementById("status");
  if (!status) {
    return;
  }

  status.textContent = text;
  status.style.color = isError ? "#ff6b6b" : "";
}

/**
 * Reads form values from the popup.
 * @returns {{keepLastN:number, minimalUi:boolean, collapseOwnMessages:boolean, collapseCodeBlocks:boolean}}
 */
function readForm() {
  const keepLastNInput = /** @type {HTMLInputElement} */ (document.getElementById("keepLastN"));
  const minimalUiInput = /** @type {HTMLInputElement} */ (document.getElementById("minimalUi"));
  const collapseOwnMessagesInput = /** @type {HTMLInputElement} */ (document.getElementById("collapseOwnMessages"));
  const collapseCodeBlocksInput = /** @type {HTMLInputElement} */ (document.getElementById("collapseCodeBlocks"));

  return {
    keepLastN: clampKeepLastN(keepLastNInput.value),
    minimalUi: Boolean(minimalUiInput.checked),
    collapseOwnMessages: Boolean(collapseOwnMessagesInput.checked),
    collapseCodeBlocks: Boolean(collapseCodeBlocksInput.checked)
  };
}

/**
 * Writes values into the popup form.
 * @param {{keepLastN:number, minimalUi:boolean, collapseOwnMessages:boolean, collapseCodeBlocks:boolean}} settings
 */
function writeForm(settings) {
  const keepLastNInput = /** @type {HTMLInputElement} */ (document.getElementById("keepLastN"));
  const minimalUiInput = /** @type {HTMLInputElement} */ (document.getElementById("minimalUi"));
  const collapseOwnMessagesInput = /** @type {HTMLInputElement} */ (document.getElementById("collapseOwnMessages"));
  const collapseCodeBlocksInput = /** @type {HTMLInputElement} */ (document.getElementById("collapseCodeBlocks"));

  keepLastNInput.value = String(clampKeepLastN(settings.keepLastN));
  minimalUiInput.checked = Boolean(settings.minimalUi);
  collapseOwnMessagesInput.checked = Boolean(settings.collapseOwnMessages);
  collapseCodeBlocksInput.checked = Boolean(settings.collapseCodeBlocks);
}

/**
 * Applies current form settings to storage and the active tab.
 */
async function applyNow() {
  const settings = readForm();

  await saveSettings(settings);

  const response = await sendMessageToActiveTab({
    type: "TRIMMER_APPLY",
    keepLastN: settings.keepLastN,
    minimalUi: settings.minimalUi,
    collapseOwnMessages: settings.collapseOwnMessages,
    collapseCodeBlocks: settings.collapseCodeBlocks
  });

  if (!response || response.ok !== true) {
    throw new Error(response?.error || "Apply failed.");
  }

  setStatus(
    `Active.\nHidden: ${response.hiddenCount} / ${response.totalCount}\nVisible turns: ${response.keepLastN}`
  );
}

/**
 * Shows all hidden turns in the active tab without changing stored settings.
 */
async function showAllNow() {
  const response = await sendMessageToActiveTab({
    type: "TRIMMER_SHOW_ALL"
  });

  if (!response || response.ok !== true) {
    throw new Error(response?.error || "Show all failed.");
  }

  setStatus("All messages in the current tab are visible again.");
}

/**
 * Resets settings to defaults and applies them.
 */
async function resetDefaults() {
  writeForm(DEFAULT_SETTINGS);
  await applyNow();
}

/**
 * Initializes popup event handlers and loads existing settings.
 */
async function initPopup() {
  const applyBtn = document.getElementById("applyBtn");
  const showAllBtn = document.getElementById("showAllBtn");
  const resetBtn = document.getElementById("resetBtn");

  if (!applyBtn || !showAllBtn || !resetBtn) {
    return;
  }

  try {
    const settings = await loadSettings();
    writeForm(settings);
    setStatus("Ready.");
  } catch (error) {
    setStatus(String(error), true);
  }

  applyBtn.addEventListener("click", async () => {
    try {
      setStatus("Applying...");
      await applyNow();
    } catch (error) {
      setStatus(String(error), true);
    }
  });

  showAllBtn.addEventListener("click", async () => {
    try {
      setStatus("Restoring...");
      await showAllNow();
    } catch (error) {
      setStatus(String(error), true);
    }
  });

  resetBtn.addEventListener("click", async () => {
    try {
      setStatus("Resetting...");
      await resetDefaults();
    } catch (error) {
      setStatus(String(error), true);
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initPopup().catch((error) => {
    setStatus(String(error), true);
  });
});