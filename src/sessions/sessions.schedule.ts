import { log } from "../utils";

/** Ташкент без перехода на летнее время */
const TASHKENT_OFFSET_H = 5;
const DAY_MS = 24 * 60 * 60_000;

export function msUntilTashkentHour(hour: number): number {
  const now = Date.now();
  const target = new Date(now);
  target.setUTCHours(hour - TASHKENT_OFFSET_H, 0, 0, 0);
  let delay = target.getTime() - now;
  while (delay <= 0) delay += DAY_MS;
  return delay;
}

/**
 * Задача раз в сутки в hour:00 по Ташкенту. Ошибка задачи логируется и не сбивает расписание.
 * Таймер unref — не держит процесс при остановке
 */
export function scheduleDailyTask(name: string, hour: number, task: () => Promise<void>): void {
  const delay = msUntilTashkentHour(hour);
  const timer = setTimeout(() => {
    void task()
      .catch((err) => log.error({ task: name, err: err?.message || String(err) }, `Ежедневная задача упала`))
      .finally(() => scheduleDailyTask(name, hour, task));
  }, delay);
  timer.unref();
  log.info(`⏰ ${name}: через ${Math.round(delay / 60_000)} мин (${hour}:00 Ташкент)`);
}
