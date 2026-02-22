# chatgpt-ui-trimmer

A lightweight browser extension for ChatGPT that hides older conversation turns and optionally reduces UI clutter.

It is designed to make long chats feel less laggy by trimming what stays visible in the page. It does **not** change the actual server-side conversation history or model context. It only changes what is shown in the browser UI.

---

## Features

- Hide older ChatGPT conversation turns
- Keep only the last **N turns** visible (configurable)
- Optional minimal UI mode (hide sidebar + some header buttons)
- Auto-reapply when ChatGPT updates the page (React re-renders, new messages)
- Small status banner showing how many messages are currently hidden

---

## What "turns" means

A **turn** is one message block in the chat UI:

- 1 user message = 1 turn
- 1 assistant message = 1 turn

So if you want to keep roughly the last **3 question/answer pairs**, set **N = 6**.

---

## Browser compatibility

This extension uses standard Chromium extension APIs (Manifest V3, `chrome.storage`, `chrome.tabs`, content scripts), so it should work in most Chromium-based desktop browsers, including:

- Microsoft Edge
- Google Chrome
- Brave
- Vivaldi
- Opera (usually works, depending on version)

The browser is usually not the problem. The fragile part is the ChatGPT UI itself. If OpenAI changes the DOM structure, selectors may need to be updated.

---

## Installation (unpacked extension)

### Microsoft Edge

1. Open `edge://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `chatgpt-ui-trimmer` folder
5. Open ChatGPT and reload the tab

### Google Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `chatgpt-ui-trimmer` folder
5. Open ChatGPT and reload the tab

### Other Chromium browsers

Use the equivalent extensions page and load the folder as an unpacked extension. The steps are usually almost identical, because browser vendors love copying each other with tiny UI differences.

---

## Usage

1. Open a ChatGPT conversation
2. Click the extension icon
3. Set **Visible messages (turns)**
4. Optional: enable or disable **Simplify UI**
5. Click **Apply**

### Buttons in the popup

- **Apply**  
  Applies the current settings and hides older messages

- **Show all**  
  Restores all currently hidden messages in the open tab

- **Reset defaults**  
  Resets settings to the default values and applies them

---

## Minimal UI mode

When enabled, the extension hides some UI elements to reduce clutter, including:

- Sidebar (chat list)
- Share button
- Conversation options button

If you want to keep the sidebar visible, disable the **Simplify UI** option in the popup.

---

## Project structure

```text
chatgpt-ui-trimmer/
├─ manifest.json
├─ content.js
├─ popup.html
└─ popup.js