import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type Browser, chromium } from "playwright";
import { isCodeScreen, telegramLoginDriver } from "../src/sessions/login/telegram.login";
import { SessionError } from "../src/type";

/**
 * Экран кода нового Web K (как на живом аккаунте): текст «sent you a message… with the code» и клетки по цифре,
 * фокус сам переходит дальше. Код 12345 — вход (появляется список чатов), другой — текст ошибки
 */
const NEW_CODE_SCREEN = `
  <div class="_card"><div>+7 982 173 3468</div>
    <p>We have sent you a message in Telegram with the code.</p>
    <div id="cells">${'<input maxlength="1" inputmode="numeric">'.repeat(5)}</div>
    <p id="error" hidden>Invalid code</p>
  </div>
  <script>
    const cells = [...document.querySelectorAll("#cells input")];
    cells[0].focus();
    cells.forEach((cell, i) => cell.addEventListener("input", () => {
      if (cell.value && cells[i + 1]) cells[i + 1].focus();
      const code = cells.map((c) => c.value).join("");
      if (code.length < 5) return;
      if (code === "12345") document.body.innerHTML = '<div id="column-left"><div class="chatlist">chats</div></div>';
      else document.getElementById("error").hidden = false;
    }));
    cells.forEach((cell, i) => cell.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !cell.value && cells[i - 1]) cells[i - 1].focus();
    }));
  </script>`;

const OLD_CODE_SCREEN = `<input class="input-field-input" type="text">`;
const PHONE_SCREEN = `<div class="input-field-input" contenteditable="true" inputmode="decimal"></div><p>Please confirm your country code</p>`;

let browser: Browser | null = null;

describe("Telegram login driver on the new Web K layout", () => {
  before(async () => {
    browser = await chromium.launch({ headless: true }).catch(() => null);
  });

  after(async () => {
    await browser?.close();
  });

  it("recognises the code screen of the new and the old layout, not the phone screen", async (t) => {
    if (!browser) return t.skip("Chromium не установлен");
    const page = await browser.newPage();

    await page.setContent(NEW_CODE_SCREEN);
    assert.equal(await isCodeScreen(page), true);
    await page.setContent(OLD_CODE_SCREEN);
    assert.equal(await isCodeScreen(page), true);
    await page.setContent(PHONE_SCREEN);
    assert.equal(await isCodeScreen(page), false);
    await page.close();
  });

  it("types the code into the cells and sees the login", async (t) => {
    if (!browser) return t.skip("Chromium не установлен");
    const page = await browser.newPage();
    await page.setContent(NEW_CODE_SCREEN);

    assert.equal(await telegramLoginDriver.submitCode(page, "12345"), "done");
    await page.close();
  });

  it("reports a wrong code as LOGIN_REJECTED with the text of Telegram", async (t) => {
    if (!browser) return t.skip("Chromium не установлен");
    const page = await browser.newPage();
    await page.setContent(NEW_CODE_SCREEN);

    await assert.rejects(
      telegramLoginDriver.submitCode(page, "11111"),
      (err: unknown) => err instanceof SessionError && err.message === "LOGIN_REJECTED" && err.detail === "Invalid code",
    );
    await page.close();
  });
});
