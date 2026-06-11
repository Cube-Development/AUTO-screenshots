import { Page } from "playwright";

export const TG_TARGET_MESSAGE_TIMEOUT_MS = 45_000;
const TG_SETTLE_MS = 2_000;

export function extractPostId(link: string): string | null {
  const m = link.match(/t\.me\/(?:c\/\d+|[^/]+)\/(\d+)/);
  return m?.[1] ?? null;
}

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
