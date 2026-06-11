import "dotenv/config";
import fs from "fs";
import http from "http";
import path from "path";
import { chromium, Page } from "playwright";
import { extractPostId, installTargetOnlyMediaGuard, waitForTargetMessage } from "../../screenshot/telegram-message";

const AUTH_PATH = path.join("src", "auth", "telegram", "user_bot_7487149368", "auth.json");
const VIEWPORT = { width: 1280, height: 1600 };
const TG_CHAT_OPEN_TIMEOUT_MS = 45_000;
const TG_WARMUP_TIMEOUT_MS = 30_000;
const TG_AUTH_WAIT_MS = 15_000;
const TG_WS_SETTLE_MS = 1_500;
const TG_WS_STABLE_MS = 4_000;
const TG_APP_READY_TIMEOUT_MS = 45_000;
const TG_AFTER_GOTO_MS = 2_000;

type DebugEvent = {
  ts: number;
  type: string;
  message: string;
  data?: Record<string, unknown>;
};

const sseClients = new Set<http.ServerResponse>();
let artifactDir = "";
let eventsLogPath = "";
let latestScreenshot = "";
let currentUrl = "";

function parseArgs(): { url: string; port: number; headless: boolean } {
  const args = process.argv.slice(2);
  let url = "";
  let port = 9876;
  let headless = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port" && args[i + 1]) {
      port = Number(args[++i]) || port;
    } else if (arg === "--headless") {
      headless = true;
    } else if (!arg.startsWith("-")) {
      url = arg;
    }
  }

  if (!url) {
    console.error("Usage: npx ts-node src/tests/screenshots/tg-debug-worker.ts <t.me/post/url> [--port 9876] [--headless]");
    process.exit(1);
  }

  return { url, port, headless };
}

function timestampLabel(): string {
  const now = new Date();
  const d = String(now.getDate()).padStart(2, "0");
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const y = now.getFullYear();
  const h = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `${d}.${m}.${y}_${h}-${min}-${s}`;
}

function emit(event: Omit<DebugEvent, "ts">): void {
  const payload: DebugEvent = { ts: Date.now(), ...event };
  const line = JSON.stringify(payload);

  console.log(`[${event.type}] ${event.message}`, event.data ?? "");

  if (eventsLogPath) {
    fs.appendFileSync(eventsLogPath, line + "\n");
  }

  for (const client of sseClients) {
    client.write(`data: ${line}\n\n`);
  }
}

function toTelegramA(url: string): string {
  return url.replace(/web\.telegram\.org\/k\//, "web.telegram.org/a/");
}

function buildWebHrefFromTgaddr(tgaddr: string): string | null {
  if (!tgaddr) return null;
  if (/tg%3A|%3A/.test(tgaddr)) {
    if (tgaddr.startsWith("https://")) return toTelegramA(tgaddr);
    return "https://web.telegram.org/a/#?tgaddr=" + tgaddr.split("tgaddr=")[1];
  }
  const raw = tgaddr.startsWith("tg://") ? tgaddr : tgaddr;
  return "https://web.telegram.org/a/#?tgaddr=" + encodeURIComponent(raw);
}

function tryResolvePrivatePostLink(link: string): string | null {
  const match = link.match(/t\.me\/c\/(\d+)\/(\d+)/);
  if (!match) return null;
  const tgaddr = `tg://privatepost?channel=${match[1]}&post=${match[2]}`;
  return `https://web.telegram.org/a/#?tgaddr=${encodeURIComponent(tgaddr)}`;
}

function tryResolveDirectTelegramKLink(link: string): string | null {
  const match = link.match(/t\.me\/([a-zA-Z0-9_]+)\/(\d+)/);
  if (!match || match[1] === "c") return null;
  const tgaddr = `tg://resolve?domain=${match[1]}&post=${match[2]}`;
  return `https://web.telegram.org/a/#?tgaddr=${encodeURIComponent(tgaddr)}`;
}

function isPrivatePostLink(link: string): boolean {
  return /t\.me\/c\/\d+\/\d+/.test(link);
}

function extractPrivateChannelId(link: string): string | null {
  return link.match(/t\.me\/c\/(\d+)/)?.[1] ?? null;
}

async function warmupTelegramSession(page: Page, link: string): Promise<void> {
  emit({ type: "warmup", message: "Warming up Telegram Web session" });
  await page.goto("https://web.telegram.org/a/", { waitUntil: "domcontentloaded", timeout: TG_WARMUP_TIMEOUT_MS });
  await page
    .waitForFunction(() => {
      const auth = localStorage.getItem("user_auth");
      return auth !== null && auth !== "null" && auth.length > 0;
    }, null, { timeout: TG_AUTH_WAIT_MS })
    .catch(() => emit({ type: "warmup", message: "user_auth not found, continuing" }));
  const settleMs = isPrivatePostLink(link) ? TG_WS_SETTLE_MS * 2 : TG_WS_SETTLE_MS;
  await page.waitForTimeout(settleMs);
}

async function dismissAppInactive(page: Page): Promise<void> {
  const inactive = page.locator("#AppInactive button");
  if (!(await inactive.first().isVisible().catch(() => false))) return;
  emit({ type: "warmup", message: "AppInactive — reloading tab" });
  await inactive.first().click().catch(() => null);
  await page.waitForLoadState("domcontentloaded").catch(() => null);
  await page.waitForTimeout(TG_WS_SETTLE_MS);
}

async function waitForTelegramConnectionReady(page: Page): Promise<void> {
  await dismissAppInactive(page);

  const wsResponse = page
    .waitForResponse((r) => /zws\d*[-.]?.*\.web\.telegram\.org/.test(r.url()) && r.status() < 400, {
      timeout: TG_APP_READY_TIMEOUT_MS,
    })
    .catch(() => null);

  await page
    .waitForFunction(
      () => {
        const inactive = document.getElementById("AppInactive");
        if (inactive?.closest(".Transition_slide-active")) return false;
        if (document.querySelector(".chat-list .Loading")) return false;
        const items = document.querySelectorAll(".chat-list .ListItem, #LeftColumn .ListItem");
        if (items.length === 0) return false;
        return Array.from(items).some((el) => {
          const title = el.querySelector(".title, .fullName, .peer-title");
          return (title?.textContent?.trim().length ?? 0) > 0;
        });
      },
      null,
      { timeout: TG_APP_READY_TIMEOUT_MS },
    )
    .catch(() => emit({ type: "warmup", message: "Chat list not loaded" }));

  await wsResponse;
  await page.waitForTimeout(TG_WS_STABLE_MS);
  emit({ type: "warmup", message: "WS and chats ready" });
}

async function gotoTelegramTarget(page: Page, target: string, link: string, postId: string | null): Promise<Page> {
  if (!isPrivatePostLink(link)) {
    if (postId) await installTargetOnlyMediaGuard(page, postId);
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => null);
    await page.waitForTimeout(TG_AFTER_GOTO_MS);
    await closeModalIfExists(page);
    return page;
  }

  await warmupTelegramSession(page, link);
  await waitForTelegramConnectionReady(page);

  const postPage = await page.context().newPage();
  await postPage.route("**/progressive/**", (route) => route.abort());
  if (postId) await installTargetOnlyMediaGuard(postPage, postId);
  attachPageListeners(postPage);
  emit({ type: "navigate", message: "Opening private post in second tab" });
  await postPage.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => null);
  await postPage.waitForTimeout(TG_AFTER_GOTO_MS);
  await closeModalIfExists(postPage);

  return postPage;
}

async function waitForChatOpened(page: Page, link: string): Promise<void> {
  emit({ type: "chat_wait", message: "Waiting for chat to open" });
  const privateChannelId = extractPrivateChannelId(link);

  if (privateChannelId) {
    const expectedHash = `-100${privateChannelId}`;
    await page.waitForFunction(
      (hashPart) => window.location.hash.includes(hashPart),
      expectedHash,
      { timeout: TG_CHAT_OPEN_TIMEOUT_MS },
    );
  } else {
    await page.waitForFunction(
      () => /^#-?\d/.test(window.location.hash) || /^#@/.test(window.location.hash),
      null,
      { timeout: TG_CHAT_OPEN_TIMEOUT_MS },
    );
  }

  const hash = await page.evaluate(() => window.location.hash);
  emit({ type: "chat_open", message: "Chat opened", data: { hash } });
}

async function saveArtifact(page: Page, name: string, html = false): Promise<string> {
  const fileName = html ? `${name}.html` : `${name}.png`;
  const filePath = path.join(artifactDir, fileName);

  if (html) {
    fs.writeFileSync(filePath, await page.content());
  } else {
    await page.screenshot({ path: filePath, fullPage: true });
    latestScreenshot = `/artifacts/${fileName}`;
  }

  emit({ type: "artifact", message: `Saved ${fileName}`, data: { file: fileName } });
  return filePath;
}

async function closeModalIfExists(page: Page): Promise<void> {
  try {
    const modal = await page.$("div.Modal.error.shown.open, div.modal-dialog, .Modal.shown");
    if (!modal) return;
    const btn = await modal.$("button, div[role='button'], .btn-primary");
    if (btn) {
      emit({ type: "modal", message: "Closing modal dialog" });
      await btn.click().catch(() => null);
      await page.waitForTimeout(500);
    }
  } catch { }
}

function attachPageListeners(page: Page): void {
  page.on("console", (msg) => {
    emit({
      type: "console",
      message: msg.text(),
      data: { level: msg.type(), url: page.url() },
    });
  });

  page.on("pageerror", (err) => {
    emit({ type: "pageerror", message: err.message, data: { stack: err.stack } });
  });

  page.on("requestfailed", (req) => {
    emit({
      type: "network",
      message: `${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "failed"}`,
    });
  });

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      currentUrl = frame.url();
      emit({ type: "navigate", message: currentUrl });
    }
  });
}

async function waitForContent(page: Page, link: string): Promise<void> {
  const postId = extractPostId(link);
  emit({
    type: "content_wait",
    message: postId ? `Waiting for message #${postId}...` : "Waiting for message content...",
    data: postId ? { postId } : undefined,
  });

  if (postId) {
    await waitForTargetMessage(page, postId);
  } else {
    await page.waitForFunction(
      () => {
        const selectors = [
          ".Message", ".message", ".message-content", ".bubble", ".text-content",
          ".Message-content", ".media-container", ".message-text", ".text",
        ];
        const msg = selectors.map((s) => document.querySelector(s)).find((el) => el !== null) as HTMLElement | undefined;
        if (!msg) return false;

        const text = msg.innerText || "";
        const hasText = text.length > 2 && !text.includes("Loading") && !text.includes("Загрузка");
        const hasMedia = msg.querySelector("img, video, canvas, .media-container, .poll, .album") !== null;
        return (hasText || hasMedia) && msg.offsetHeight > 20;
      },
      null,
      { timeout: 30000 },
    );
    await page.waitForTimeout(3000);
  }

  emit({
    type: "content_ready",
    message: postId ? `Message #${postId} rendered` : "Message content rendered",
    data: postId ? { postId } : undefined,
  });
}

async function runScenario(page: Page, link: string): Promise<void> {
  let target = tryResolvePrivatePostLink(link);

  if (target) {
    emit({ type: "privatepath", message: "Private post link", data: { target } });
  } else {
    target = tryResolveDirectTelegramKLink(link);
    if (target) {
      emit({ type: "fastpath", message: "Direct web.telegram.org link", data: { target } });
    } else {
      emit({ type: "slowpath", message: "Opening t.me page", data: { link } });
      await page.goto(link, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(500);
      await saveArtifact(page, "01-tme");

      const btn = await page.$("a.tgme_action_web_button, a.tgme_action_button_new, a.tgme_action_button");
      if (!btn) {
        emit({ type: "button_missing", message: "Open in Web button not found" });
        await saveArtifact(page, "02-no-button");
        await saveArtifact(page, "02-no-button-dom", true);
        throw new Error("Кнопка 'Open in Web' не найдена");
      }

      emit({ type: "button_found", message: "Open in Web button found" });
      const hrefAttr = await btn.getAttribute("href");

      if (hrefAttr) {
        if (hrefAttr.includes("web.telegram.org")) target = hrefAttr;
        else if (hrefAttr.includes("tgaddr") || hrefAttr.startsWith("tg://") || hrefAttr.includes("privatepost"))
          target = buildWebHrefFromTgaddr(hrefAttr);
        else if (hrefAttr.startsWith("/")) target = "https://t.me" + hrefAttr;
      }

      if (!target) {
        const html = await page.content();
        const m = html.match(/(tg(?:%3A|:)\/\/privatepost[^"]+)/i) || html.match(/tgaddr=([^"'&]+)/i);
        if (m) target = buildWebHrefFromTgaddr(m[1] ?? m[0]);
      }
    }
  }

  if (!target) throw new Error("Не удалось определить целевой URL");

  target = toTelegramA(target);
  const postId = extractPostId(link);
  emit({ type: "target_resolved", message: "Navigating to Telegram Web A", data: { target, postId } });

  page = await gotoTelegramTarget(page, target, link, postId);
  await saveArtifact(page, "02-web-a");
  await saveArtifact(page, "02-web-a-dom", true);
  await waitForChatOpened(page, link);

  await waitForContent(page, link);

  const finalPath = path.join(artifactDir, "03-final.png");
  await page.screenshot({ path: finalPath, fullPage: false });
  latestScreenshot = "/artifacts/03-final.png";
  emit({ type: "screenshot", message: "Final screenshot saved", data: { file: "03-final.png" } });
}

function getDashboardHtml(port: number): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <title>TG Debug Worker</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 0; background: #0f1115; color: #e8eaed; }
    header { padding: 16px 20px; border-bottom: 1px solid #2a2f3a; }
    main { display: grid; grid-template-columns: 1fr 420px; gap: 16px; padding: 16px; min-height: calc(100vh - 65px); }
    .panel { background: #171a21; border: 1px solid #2a2f3a; border-radius: 10px; padding: 12px; }
    #events { height: calc(100vh - 120px); overflow: auto; font-family: ui-monospace, monospace; font-size: 12px; }
    .event { padding: 8px; border-bottom: 1px solid #222833; white-space: pre-wrap; word-break: break-word; }
    .event .type { color: #7dd3fc; font-weight: 600; }
    .event.error .type { color: #f87171; }
    .event.screenshot .type { color: #86efac; }
    #preview { width: 100%; border-radius: 8px; border: 1px solid #2a2f3a; background: #000; }
    #url { color: #94a3b8; font-size: 13px; margin-top: 8px; word-break: break-all; }
    .status { color: #86efac; }
  </style>
</head>
<body>
  <header>
    <strong>TG Debug Worker</strong>
    <span class="status" id="status"> connecting...</span>
    <div id="url"></div>
  </header>
  <main>
    <section class="panel">
      <h3>Events</h3>
      <div id="events"></div>
    </section>
    <section class="panel">
      <h3>Latest screenshot</h3>
      <img id="preview" alt="screenshot" />
    </section>
  </main>
  <script>
    const eventsEl = document.getElementById('events');
    const previewEl = document.getElementById('preview');
    const statusEl = document.getElementById('status');
    const urlEl = document.getElementById('url');
    const es = new EventSource('/events');

    es.onopen = () => { statusEl.textContent = ' connected'; };
    es.onerror = () => { statusEl.textContent = ' disconnected'; };

    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      const div = document.createElement('div');
      div.className = 'event ' + ev.type;
      const time = new Date(ev.ts).toLocaleTimeString();
      div.innerHTML = '<span class="type">[' + ev.type + ']</span> ' + time + ' — ' + ev.message;
      eventsEl.prepend(div);

      if (ev.type === 'navigate') urlEl.textContent = ev.message;
      if (ev.type === 'artifact' || ev.type === 'screenshot') {
        previewEl.src = '/artifacts/' + ev.data.file + '?t=' + Date.now();
      }
    };
  </script>
</body>
</html>`;
}

function startServer(port: number): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";

    if (url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getDashboardHtml(port));
      return;
    }

    if (url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (url.startsWith("/artifacts/")) {
      const fileName = path.basename(url.split("?")[0]);
      const filePath = path.join(artifactDir, fileName);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": fileName.endsWith(".png") ? "image/png" : "text/html" });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(port, () => {
    console.log(`Dashboard: http://localhost:${port}`);
  });

  return server;
}

async function main(): Promise<void> {
  const { url, port, headless } = parseArgs();

  if (!fs.existsSync(AUTH_PATH)) {
    console.error(`Auth not found: ${AUTH_PATH}`);
    console.error("Run: npm run auth:telegram");
    process.exit(1);
  }

  artifactDir = path.join("src", "tests", "screenshots", "debug", timestampLabel());
  fs.mkdirSync(artifactDir, { recursive: true });
  eventsLogPath = path.join(artifactDir, "events.jsonl");

  const server = startServer(port);

  emit({ type: "session_loaded", message: "Auth session loaded", data: { auth: AUTH_PATH, postUrl: url } });

  const browser = await chromium.launch({
    headless,
    slowMo: headless ? 0 : 100,
    args: ["--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"],
  });

  const context = await browser.newContext({
    storageState: AUTH_PATH,
    viewport: VIEWPORT,
  });

  const page = await context.newPage();
  attachPageListeners(page);

  try {
    await runScenario(page, url);
    emit({ type: "done", message: "Debug run completed", data: { artifacts: artifactDir } });
    console.log(`\nArtifacts: ${artifactDir}`);
    console.log(`Dashboard: http://localhost:${port}`);
    console.log("Press Ctrl+C to exit (browser stays open for inspection).");

    await new Promise<void>(() => { });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: "error", message, data: { stack: err instanceof Error ? err.stack : undefined } });
    await saveArtifact(page, "error-state").catch(() => null);
    console.error(`\nFailed: ${message}`);
    console.log(`Artifacts: ${artifactDir}`);
    console.log(`Dashboard: http://localhost:${port}`);
    console.log("Press Ctrl+C to exit.");
    process.exitCode = 1;
    await new Promise<void>(() => { });
  }
}

main();
