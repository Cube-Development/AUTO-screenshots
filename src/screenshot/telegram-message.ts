import { Page } from "playwright";

export const TG_TARGET_MESSAGE_TIMEOUT_MS = 45_000;
const TG_SETTLE_MS = 2_000;
const TG_VIEWPORT_WAIT_MS = 15_000;
const TG_K_MID_OFFSET = 2 ** 32;

export function extractPostId(link: string): string | null {
  const m = link.match(/t\.me\/(?:c\/\d+|[^/]+)\/(\d+)/);
  return m?.[1] ?? null;
}

/** Telegram K: data-mid = postId + 2^32 */
export function postIdToKMid(postId: string): string {
  return String(Number(postId) + TG_K_MID_OFFSET);
}

export function kMidToPostId(mid: string): string | null {
  const n = Number(mid);
  if (!Number.isFinite(n) || n < TG_K_MID_OFFSET) return null;
  return String(n - TG_K_MID_OFFSET);
}

type ViewportBubble = { mid: string; ready: boolean };

function installMediaGuard(postId: string): void {
  const targetId = `message-${postId}`;

  const stripMessageVideo = (msg: Element): void => {
    if (msg.id === targetId || !msg.classList.contains("Message")) return;
    msg.querySelectorAll("video").forEach((node) => {
      if (!(node instanceof HTMLVideoElement)) return;
      node.removeAttribute("src");
      node.src = "";
      node.load();
    });
  };

  const stripAll = (): void => {
    document.querySelectorAll(".Message").forEach(stripMessageVideo);
  };

  if (!document.getElementById("ss-target-only-media-style")) {
    const style = document.createElement("style");
    style.id = "ss-target-only-media-style";
    style.textContent = `
      #MiddleColumn .Message:not(#${targetId}) video,
      #MiddleColumn .Message:not(#${targetId}) .video-preview {
        visibility: hidden !important;
        pointer-events: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  stripAll();

  const w = window as unknown as { __ssMediaGuard?: MutationObserver; __ssMediaGuardTimer?: number };
  if (!w.__ssMediaGuard) {
    const scheduleStrip = (): void => {
      if (w.__ssMediaGuardTimer) return;
      w.__ssMediaGuardTimer = window.setTimeout(() => {
        w.__ssMediaGuardTimer = undefined;
        stripAll();
      }, 150);
    };
    const observer = new MutationObserver(scheduleStrip);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    w.__ssMediaGuard = observer;
  }
}

export async function installTargetOnlyMediaGuard(page: Page, postId: string): Promise<void> {
  await page.addInitScript(installMediaGuard, postId);
}

export async function stripNonTargetMedia(page: Page, postId: string): Promise<void> {
  await page.evaluate(installMediaGuard, postId);
}

function assertPageOpen(page: Page, signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("ABORTED_BY_CLIENT");
  if (page.isClosed()) throw new Error("PAGE_CLOSED: browser/context закрыт во время ожидания");
}

export async function waitForTargetMessage(page: Page, postId: string, signal?: AbortSignal): Promise<void> {
  assertPageOpen(page, signal);

  await page.waitForFunction(
    (id) => {
      const el = (document.querySelector(`#message-${id}`) ?? document.querySelector(`[data-message-id="${id}"]`)) as HTMLElement | null;
      if (!el) return false;

      const text = el.innerText || "";
      const hasText = text.length > 2 && !text.includes("Loading") && !text.includes("Загрузка");
      if (el.querySelector(".poll")) {
        el.scrollIntoView({ block: "center", behavior: "instant" });
        return el.offsetHeight > 20;
      }

      const mediaImgs = Array.from(el.querySelectorAll("img")).filter(
        (img) =>
          !img.classList.contains("emoji") &&
          !img.classList.contains("a8dMNkh3") &&
          !img.classList.contains("emoji-small"),
      );
      const hasMediaShell =
        el.querySelector(".media-container, .Album, .media-inner, .video-preview, video") !== null;

      el.scrollIntoView({ block: "center", behavior: "instant" });

      if (hasMediaShell || mediaImgs.length > 0) {
        const loadedImg = mediaImgs.some((img) => img.complete && img.naturalWidth > 50);
        const videoShell = el.querySelector(".video-preview, .thumbnail, .media-container") as HTMLElement | null;
        const hasVideoLayout = !!videoShell && videoShell.offsetHeight > 80;
        return (loadedImg || hasVideoLayout || hasText) && el.offsetHeight > 20;
      }

      return hasText && el.offsetHeight > 20;
    },
    postId,
    { timeout: TG_TARGET_MESSAGE_TIMEOUT_MS },
  );

  assertPageOpen(page, signal);
  await stripNonTargetMedia(page, postId);
  await page.waitForTimeout(TG_SETTLE_MS);

  await page.evaluate((id) => {
    const el = document.querySelector(`#message-${id}`) ?? document.querySelector(`[data-message-id="${id}"]`);
    el?.scrollIntoView({ block: "center", behavior: "instant" });
  }, postId);

  await page.waitForTimeout(500);
}

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

    const pick = (el: HTMLElement): ViewportBubble => {
      const text = el.innerText || "";
      const hasText = text.length > 2 && !text.includes("Loading") && !text.includes("Загрузка");
      const hasMedia = !!el.querySelector(
        ".media-photo, .media-container, .attachment, video, .album-item, .preloader-container",
      );
      return { mid: el.getAttribute("data-mid") ?? "", ready: (hasText || hasMedia) && el.offsetHeight > 20 };
    };

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

async function centerBubbleByMid(page: Page, mid: string): Promise<void> {
  await page.evaluate((id) => {
    const el = document.querySelector(`.bubble[data-mid="${id}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "center", behavior: "instant" });
  }, mid);
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

export async function waitForKTargetMessage(page: Page, postId: string | null, signal?: AbortSignal): Promise<string | null> {
  assertPageOpen(page, signal);

  if (postId) {
    const mid = postIdToKMid(postId);

    await page.waitForFunction(
      (targetMid) => {
        const el = document.querySelector(
          `#column-center .bubble[data-mid="${targetMid}"]`,
        ) as HTMLElement | null;
        if (!el || el.classList.contains("service") || el.classList.contains("is-date")) return false;

        const text = el.innerText || "";
        const hasText = text.length > 2 && !text.includes("Loading") && !text.includes("Загрузка");
        const hasMedia = !!el.querySelector(
          ".media-photo, .media-container, .attachment, video, .album-item, .preloader-container",
        );
        const ready = (hasText || hasMedia) && el.offsetHeight > 20;
        if (ready) el.scrollIntoView({ block: "center", behavior: "instant" });
        return ready;
      },
      mid,
      { timeout: TG_TARGET_MESSAGE_TIMEOUT_MS },
    );

    assertPageOpen(page, signal);
    await centerBubbleByMid(page, mid);
    await page.waitForTimeout(TG_SETTLE_MS);
    return mid;
  }

  const deadline = Date.now() + TG_VIEWPORT_WAIT_MS;
  while (Date.now() < deadline) {
    assertPageOpen(page, signal);
    const found = await findViewportBubble(page);
    if (found?.mid && found.ready) {
      await centerBubbleByMid(page, found.mid);
      await page.waitForTimeout(TG_SETTLE_MS);
      return found.mid;
    }
    if (found?.mid) {
      await page.waitForTimeout(500);
      continue;
    }
    await page.waitForTimeout(400);
  }

  const bubbleCount = await countKBubbles(page);
  if (bubbleCount === 0) {
    for (let i = 0; i < 20; i++) {
      assertPageOpen(page, signal);
      const scrolled = (await scrollKChat(page, "up")) || (await scrollKChat(page, "down"));
      if (!scrolled) break;
      await page.waitForTimeout(350);
      const found = await findViewportBubble(page);
      if (found?.mid) {
        await centerBubbleByMid(page, found.mid);
        await page.waitForTimeout(TG_SETTLE_MS);
        return found.mid;
      }
    }
  }

  const last = await findViewportBubble(page);
  if (last?.mid) {
    await centerBubbleByMid(page, last.mid);
    await page.waitForTimeout(TG_SETTLE_MS);
    return last.mid;
  }

  return null;
}
