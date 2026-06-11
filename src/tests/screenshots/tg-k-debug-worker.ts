import "dotenv/config";
import fs from "fs";
import http from "http";
import path from "path";
import { chromium, Page } from "playwright";
import { extractPostId } from "../../screenshot/telegram-message";

const AUTH_PATH = path.join("src", "auth", "telegram", "user_bot_7487149368", "auth.json");
const VIEWPORT = { width: 1280, height: 1600 };
const TG_CHAT_OPEN_TIMEOUT_MS = 45_000;
const TG_WARMUP_TIMEOUT_MS = 30_000;
const TG_AUTH_WAIT_MS = 15_000;
const TG_WS_SETTLE_MS = 1_000;
const TG_WS_STABLE_MS = 1_000;
const TG_APP_READY_TIMEOUT_MS = 15_000;
const TG_AFTER_GOTO_MS = 800;
const TG_NAV_SETTLE_MS = 1_000;
const TG_VIEWPORT_WAIT_MS = 15_000;
const TG_SETTLE_MS = 2_000;

type DebugEvent = {
  ts: number;
  type: string;
  message: string;
  data?: Record<string, unknown>;
};

const sseClients = new Set<http.ServerResponse>();
let artifactDir = "";
let eventsLogPath = "";
let scenarioT0 = 0;

function emitTiming(stage: string): void {
  emit({ type: "timing", message: stage, data: { elapsed_ms: Date.now() - scenarioT0 } });
}

function parseArgs(): { url: string; port: number; headless: boolean } {
  const args = process.argv.slice(2);
  let url = "";
  let port = 9877;
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
    console.error(
      "Usage: npx ts-node src/tests/screenshots/tg-k-debug-worker.ts <t.me/post/url> [--port 9877] [--headless]",
    );
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
  if (eventsLogPath) fs.appendFileSync(eventsLogPath, line + "\n");
  for (const client of sseClients) client.write(`data: ${line}\n\n`);
}

function toTelegramK(url: string): string {
  return url.replace(/web\.telegram\.org\/a\//, "web.telegram.org/k/");
}

function buildTgaddrUrl(tgaddr: string): string {
  const raw = tgaddr.startsWith("tg://") ? tgaddr : tgaddr;
  return `https://web.telegram.org/k/#?tgaddr=${encodeURIComponent(raw)}`;
}

function buildWebHrefFromTgaddr(href: string): string | null {
  if (!href) return null;
  if (href.includes("web.telegram.org")) return toTelegramK(href);
  if (href.includes("tgaddr=")) {
    const part = href.split("tgaddr=")[1];
    return part ? `https://web.telegram.org/k/#?tgaddr=${part}` : null;
  }
  if (href.startsWith("tg://") || href.includes("privatepost") || href.includes("resolve")) {
    return buildTgaddrUrl(href);
  }
  return null;
}

function isPrivatePostLink(link: string): boolean {
  return /t\.me\/c\/\d+\/\d+/.test(link);
}

function extractPrivateChannelId(link: string): string | null {
  return link.match(/t\.me\/c\/(\d+)/)?.[1] ?? null;
}

function tryResolveTgaddrTarget(link: string): string | null {
  const privateMatch = link.match(/t\.me\/c\/(\d+)\/(\d+)/);
  if (privateMatch) {
    return buildTgaddrUrl(`tg://privatepost?channel=${privateMatch[1]}&post=${privateMatch[2]}`);
  }
  const publicMatch = link.match(/t\.me\/([a-zA-Z0-9_]+)\/(\d+)/);
  if (publicMatch && publicMatch[1] !== "c") {
    return buildTgaddrUrl(`tg://resolve?domain=${publicMatch[1]}&post=${publicMatch[2]}`);
  }
  return null;
}

async function resolveTarget(page: Page, link: string): Promise<string> {
  const direct = tryResolveTgaddrTarget(link);
  if (direct) {
    emit({ type: "fastpath", message: "tgaddr target", data: { target: direct } });
    return direct;
  }

  emit({ type: "slowpath", message: "Resolving via t.me", data: { link } });
  await page.goto(link, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(500);
  await saveArtifact(page, "01-tme");

  const btn = await page.$("a.tgme_action_web_button, a.tgme_action_button_new, a.tgme_action_button");
  if (!btn) throw new Error("Кнопка Open in Web не найдена");

  const hrefAttr = await btn.getAttribute("href");
  let target: string | null = null;
  if (hrefAttr) {
    if (hrefAttr.includes("web.telegram.org")) target = toTelegramK(hrefAttr);
    else target = buildWebHrefFromTgaddr(hrefAttr);
  }
  if (!target) {
    const html = await page.content();
    const m = html.match(/(tg(?:%3A|:)\/\/privatepost[^"]+)/i) || html.match(/tgaddr=([^"'&]+)/i);
    if (m) target = buildWebHrefFromTgaddr(m[1] ?? m[0]);
  }
  if (!target) throw new Error("Не удалось получить web-ссылку с t.me");
  emit({ type: "target_resolved", message: "t.me target", data: { target } });
  return target;
}

async function warmupKSession(page: Page, link: string): Promise<void> {
  emit({ type: "warmup", message: "Warming up Telegram Web K" });
  await page.goto("https://web.telegram.org/k/", { waitUntil: "domcontentloaded", timeout: TG_WARMUP_TIMEOUT_MS });
  await page
    .waitForFunction(() => {
      const auth = localStorage.getItem("user_auth");
      return auth !== null && auth !== "null" && auth.length > 0;
    }, null, { timeout: TG_AUTH_WAIT_MS })
    .catch(() => emit({ type: "warmup", message: "user_auth not found, continuing" }));
  await page.waitForTimeout(TG_WS_SETTLE_MS);
}

async function waitForKConnectionReady(page: Page): Promise<void> {
  const wsResponse = page
    .waitForResponse((r) => /zws\d*[-.]?.*\.web\.telegram\.org/.test(r.url()) && r.status() < 400, {
      timeout: TG_APP_READY_TIMEOUT_MS,
    })
    .catch(() => null);

  await page
    .waitForFunction(
      () => {
        const auth = localStorage.getItem("user_auth");
        if (!auth || auth === "null" || auth.length === 0) return false;
        if (!document.getElementById("page-chats")) return false;
        return document.querySelector(".chatlist-chat, a[data-peer-id]") !== null;
      },
      null,
      { timeout: TG_APP_READY_TIMEOUT_MS },
    )
    .catch(() => emit({ type: "warmup", message: "Minimal UI gate timeout, continuing" }));

  await wsResponse;
  await page.waitForTimeout(TG_WS_STABLE_MS);
  emit({ type: "warmup", message: "WS and chats ready" });
}

async function hasKChatContent(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    if (document.querySelectorAll("#column-center .bubble[data-mid]").length > 0) return true;
    const chat = document.querySelector("#column-center .chat.active");
    if (!chat) return false;
    return chat.querySelector(".bubbles, .bubbles-inner, .scrollable") !== null && chat.innerHTML.length > 800;
  });
}

async function getPageNavState(page: Page): Promise<{ href: string; hash: string }> {
  return page.evaluate(() => ({ href: location.href, hash: location.hash }));
}

async function setHash(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    location.hash = h;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }, hash);
}

async function navigatePrivatePost(page: Page, link: string, target: string): Promise<void> {
  const channelId = extractPrivateChannelId(link);
  const postId = extractPostId(link);
  if (!channelId) return;

  const steps: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: "assign-tgaddr",
      run: async () => {
        await page.evaluate((url) => location.assign(url), target);
      },
    },
    {
      name: `hash-#-${channelId}`,
      run: async () => setHash(page, `#-${channelId}`),
    },
    ...(postId
      ? [{ name: `hash-#-100${channelId}_${postId}`, run: async () => setHash(page, `#-100${channelId}_${postId}`) }]
      : []),
    {
      name: `hash-#-100${channelId}`,
      run: async () => setHash(page, `#-100${channelId}`),
    },
  ];

  for (const step of steps) {
    emit({ type: "nav_step", message: step.name, data: { target } });
    await step.run();
    await page.waitForTimeout(TG_NAV_SETTLE_MS);
    await dismissKSuggestions(page);
    await closeModalIfExists(page);

    const state = await getPageNavState(page);
    emit({ type: "nav_state", message: step.name, data: state });

    if (await hasKChatContent(page)) return;
  }
}

async function waitForKChatOpen(page: Page, link: string): Promise<void> {
  const channelId = extractPrivateChannelId(link);
  emit({ type: "chat_wait", message: "Waiting for K chat" });

  await page
    .waitForFunction(
      (cid) => {
        if (document.querySelectorAll("#column-center .bubble[data-mid]").length > 0) return true;
        const hash = window.location.hash;
        if (cid && (hash.includes(`-${cid}`) || hash.includes(`-100${cid}`))) {
          return !!document.querySelector("#column-center .chat.active .bubbles, #column-center .bubbles");
        }
        return /^#-?\d/.test(hash) || /^#@/.test(hash);
      },
      channelId,
      { timeout: TG_CHAT_OPEN_TIMEOUT_MS },
    )
    .catch(() => emit({ type: "chat_wait", message: "Chat open timeout, continuing" }));

  const state = await getPageNavState(page);
  emit({ type: "chat_open", message: "Chat state", data: state });
}

async function dismissKSuggestions(page: Page): Promise<void> {
  await page
    .locator(".chatlist-overlay .btn-icon.close, ._suggestionContainer_5ffcx_5 .close")
    .first()
    .click({ timeout: 1_000 })
    .catch(() => null);
}

type ViewportBubble = { mid: string; ready: boolean };

async function findViewportBubble(page: Page): Promise<ViewportBubble | null> {
  return page.evaluate(() => {
    const column = document.querySelector("#column-center");
    if (!column) return null;

    const columnRect = column.getBoundingClientRect();
    const cx = columnRect.left + columnRect.width / 2;
    const cy = columnRect.top + columnRect.height / 2;

    const bubbles = Array.from(
      document.querySelectorAll("#column-center .bubble[data-mid]:not(.service):not(.is-date)"),
    ) as HTMLElement[];

    const pick = (el: HTMLElement): ViewportBubble => ({
      mid: el.getAttribute("data-mid") ?? "",
      ready:
        (() => {
          const text = el.innerText || "";
          const hasText = text.length > 2 && !text.includes("Loading") && !text.includes("Загрузка");
          const hasMedia = !!el.querySelector(
            ".media-photo, .media-container, .attachment, video, .album-item, .preloader-container",
          );
          return (hasText || hasMedia) && el.offsetHeight > 20;
        })(),
    });

    for (const bubble of bubbles) {
      const r = bubble.getBoundingClientRect();
      if (r.bottom < columnRect.top || r.top > columnRect.bottom) continue;
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom && bubble.offsetHeight > 20) {
        return pick(bubble);
      }
    }

    let best: { bubble: HTMLElement; dist: number } | null = null;
    for (const bubble of bubbles) {
      const r = bubble.getBoundingClientRect();
      if (r.bottom < columnRect.top || r.top > columnRect.bottom || bubble.offsetHeight < 20) continue;
      const dist = Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy);
      if (!best || dist < best.dist) best = { bubble, dist };
    }

    return best ? pick(best.bubble) : null;
  });
}

async function countKBubbles(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll("#column-center .bubble[data-mid]").length);
}

async function scrollKChat(page: Page, direction: "up" | "down"): Promise<boolean> {
  return page.evaluate((dir) => {
    const sc = document.querySelector(
      "#column-center .bubbles .scrollable.scrollable-y, #column-center .scrollable.scrollable-y",
    ) as HTMLElement | null;
    if (!sc) return false;
    const prev = sc.scrollTop;
    sc.scrollTop += dir === "up" ? -900 : 900;
    return sc.scrollTop !== prev;
  }, direction);
}

async function centerBubbleByMid(page: Page, mid: string): Promise<void> {
  await page.evaluate((id) => {
    const el = document.querySelector(`.bubble[data-mid="${id}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "center", behavior: "instant" });
  }, mid);
}

async function waitForKTargetPost(page: Page): Promise<void> {
  emit({ type: "content_wait", message: "Waiting for post bubble in viewport (K)" });

  const deadline = Date.now() + TG_VIEWPORT_WAIT_MS;
  while (Date.now() < deadline) {
    const found = await findViewportBubble(page);
    if (found?.mid && found.ready) {
      await centerBubbleByMid(page, found.mid);
      await page.waitForTimeout(TG_SETTLE_MS);
      emit({ type: "content_ready", message: "Post ready in viewport", data: { resolved_mid: found.mid } });
      return;
    }
    if (found?.mid) {
      await page.waitForTimeout(500);
      continue;
    }
    await page.waitForTimeout(400);
  }

  const bubbleCount = await countKBubbles(page);
  if (bubbleCount === 0) {
    emit({ type: "scroll", message: "No bubbles in chat, scrolling", data: { bubbleCount } });
    for (let i = 0; i < 20; i++) {
      const scrolled = (await scrollKChat(page, "up")) || (await scrollKChat(page, "down"));
      if (!scrolled) break;
      await page.waitForTimeout(350);
      const found = await findViewportBubble(page);
      if (found?.mid) {
        await centerBubbleByMid(page, found.mid);
        await page.waitForTimeout(TG_SETTLE_MS);
        emit({ type: "content_ready", message: "Post found after scroll", data: { resolved_mid: found.mid } });
        return;
      }
    }
  }

  const last = await findViewportBubble(page);
  if (last?.mid) {
    await centerBubbleByMid(page, last.mid);
    await page.waitForTimeout(TG_SETTLE_MS);
    emit({ type: "content_ready", message: "Post in viewport (relaxed)", data: { resolved_mid: last.mid } });
    return;
  }

  const mids = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#column-center .bubble[data-mid]"))
      .map((el) => el.getAttribute("data-mid"))
      .filter(Boolean)
      .slice(0, 20),
  );
  emit({ type: "diagnostic", message: "Visible mids", data: { mids, bubbleCount } });
  throw new Error("Пост не найден в viewport");
}

async function saveArtifact(page: Page, name: string, html = false): Promise<void> {
  const fileName = html ? `${name}.html` : `${name}.png`;
  const filePath = path.join(artifactDir, fileName);
  if (html) fs.writeFileSync(filePath, await page.content());
  else await page.screenshot({ path: filePath, fullPage: true });
  emit({ type: "artifact", message: `Saved ${fileName}`, data: { file: fileName } });
}

async function closeModalIfExists(page: Page): Promise<void> {
  const modal = await page.$(".popup-container.active, .popup.active, div.modal-dialog");
  if (!modal) return;
  const btn = await modal.$("button, .btn-primary, .popup-close");
  if (btn) {
    await btn.click().catch(() => null);
    await page.waitForTimeout(500);
  }
}

function attachPageListeners(page: Page): void {
  page.on("console", (msg) => {
    emit({ type: "console", message: msg.text(), data: { level: msg.type(), url: page.url() } });
  });
  page.on("pageerror", (err) => {
    emit({ type: "pageerror", message: err.message, data: { stack: err.stack } });
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) emit({ type: "navigate", message: frame.url() });
  });
}

async function runScenario(page: Page, link: string): Promise<void> {
  scenarioT0 = Date.now();
  await page.route("**/progressive/**", (route) => route.abort());

  const target = await resolveTarget(page, link);
  const postId = extractPostId(link);

  if (isPrivatePostLink(link)) {
    emit({ type: "navigate", message: "private: warmup + fast nav", data: { target, postId } });
    await warmupKSession(page, link);
    emitTiming("after_warmup");
    await waitForKConnectionReady(page);
    emitTiming("after_connection_ready");
    await navigatePrivatePost(page, link, target);
    emitTiming("after_private_nav");
    await waitForKChatOpen(page, link);
    emitTiming("after_chat_open");
  } else {
    emit({ type: "navigate", message: "public: goto tgaddr", data: { target, postId } });
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => null);
    await page.waitForTimeout(TG_AFTER_GOTO_MS);
    await closeModalIfExists(page);
  }

  await saveArtifact(page, "02-web-k");
  await saveArtifact(page, "02-web-k-dom", true);

  if (postId) await waitForKTargetPost(page);

  const finalPath = path.join(artifactDir, "03-final.png");
  await page.screenshot({ path: finalPath, fullPage: false });
  emit({ type: "screenshot", message: "Final screenshot saved", data: { file: "03-final.png" } });
}

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8" /><title>TG K Debug</title>
<style>body{font-family:system-ui;margin:0;background:#0f1115;color:#e8eaed}header{padding:16px;border-bottom:1px solid #2a2f3a}
main{display:grid;grid-template-columns:1fr 420px;gap:16px;padding:16px}.panel{background:#171a21;border:1px solid #2a2f3a;border-radius:10px;padding:12px}
#events{height:calc(100vh - 120px);overflow:auto;font-family:monospace;font-size:12px}.event{padding:8px;border-bottom:1px solid #222}
#preview{width:100%;border-radius:8px}#url{color:#94a3b8;font-size:13px;margin-top:8px;word-break:break-all}</style></head>
<body><header><strong>TG K Debug Worker</strong><span id="status"></span><div id="url"></div></header>
<main><section class="panel"><h3>Events</h3><div id="events"></div></section>
<section class="panel"><h3>Screenshot</h3><img id="preview" /></section></main>
<script>
const es=new EventSource('/events');const eventsEl=document.getElementById('events');const previewEl=document.getElementById('preview');const urlEl=document.getElementById('url');
es.onmessage=(e)=>{const ev=JSON.parse(e.data);const div=document.createElement('div');div.className='event '+ev.type;div.textContent='['+ev.type+'] '+new Date(ev.ts).toLocaleTimeString()+' — '+ev.message;eventsEl.prepend(div);
if(ev.type==='navigate')urlEl.textContent=ev.message;if((ev.type==='artifact'||ev.type==='screenshot')&&ev.data?.file)previewEl.src='/artifacts/'+ev.data.file+'?t='+Date.now();};
</script></body></html>`;
}

function startServer(preferredPort: number): Promise<{ server: http.Server; port: number }> {
  const createHandler = (): http.RequestListener => (req, res) => {
    const url = req.url ?? "/";
    if (url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getDashboardHtml());
      return;
    }
    if (url === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
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
  };

  return new Promise((resolve, reject) => {
    const tryListen = (port: number, left: number): void => {
      const server = http.createServer(createHandler());
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && left > 0) {
          emit({ type: "server", message: `Port ${port} busy, trying ${port + 1}` });
          tryListen(port + 1, left - 1);
          return;
        }
        reject(err);
      });
      server.listen(port, () => {
        console.log(`Dashboard: http://localhost:${port}`);
        resolve({ server, port });
      });
    };
    tryListen(preferredPort, 15);
  });
}

async function main(): Promise<void> {
  const { url, port, headless } = parseArgs();

  if (!fs.existsSync(AUTH_PATH)) {
    console.error(`Auth not found: ${AUTH_PATH}`);
    process.exit(1);
  }

  artifactDir = path.join("src", "tests", "screenshots", "debug-k", timestampLabel());
  fs.mkdirSync(artifactDir, { recursive: true });
  eventsLogPath = path.join(artifactDir, "events.jsonl");

  const { port: actualPort } = await startServer(port);
  emit({ type: "session_loaded", message: "Auth session loaded (K)", data: { auth: AUTH_PATH, postUrl: url } });

  const browser = await chromium.launch({
    headless,
    slowMo: headless ? 0 : 100,
    args: ["--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"],
  });

  const context = await browser.newContext({ storageState: AUTH_PATH, viewport: VIEWPORT });
  const page = await context.newPage();
  attachPageListeners(page);

  try {
    await runScenario(page, url);
    emit({ type: "done", message: "K debug run completed", data: { artifacts: artifactDir } });
    console.log(`\nArtifacts: ${artifactDir}`);
    console.log(`Dashboard: http://localhost:${actualPort}`);
    console.log("Press Ctrl+C to exit.");
    await new Promise<void>(() => {});
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: "error", message, data: { stack: err instanceof Error ? err.stack : undefined } });
    await saveArtifact(page, "error-state").catch(() => null);
    console.error(`\nFailed: ${message}`);
    console.log(`Artifacts: ${artifactDir}`);
    process.exitCode = 1;
    await new Promise<void>(() => {});
  }
}

main();
