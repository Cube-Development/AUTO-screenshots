import { Request, Response } from "express";
import { z } from "zod";
import { postScreenshot } from "../../services";
import { log, determineResourceType } from "../../utils";
import { SETTINGS } from "../../config";
import { notifyTelegram } from "../../services/telegram-notify";
import crypto from "crypto";
import { IPostScreenshotResponse, ResourceType } from "../../type";
import { PostScreenShotSchema } from "./dto";

export const createPostScreenshot = async (req: Request, res: Response) => {
    const parsed = PostScreenShotSchema.safeParse(req.body);

     if (!parsed.success) {
        const errors = z.treeifyError(parsed.error);

        return res.status(422).json({
            success: false,
            code: 1001,
            message: "VALIDATION_ERROR",
            errors: errors?.properties,
        });
    }

    const { post_url, user_bot_id, order_id = "", channel_url = "" } = parsed.data;
    
    // Внутренний ID запроса для отслеживания очереди
    const reqId = crypto.randomUUID();

    // Поддержка отмены со стороны клиента
    const abortController = new AbortController();
    
    // YouTube — фоновый режим: отвечаем 202 сразу (ТОЛЬКО В ТЕСТОВОМ РЕЖИМЕ)
    const type = determineResourceType(post_url);
    const isYoutube = type === ResourceType.YOUTUBE;
    const logCtx = { id: reqId, type, url: post_url };

    if (isYoutube && SETTINGS.TEST_SCREENSHOTS) {
        log.info(logCtx, `YouTube запрос принят (TEST_MODE), запускаем timelapse в фоне`);
        res.status(202).json({
            success: true,
            message: "YouTube timelapse запущен в фоне (debug mode)",
            reqId,
        });

        // Фоновая задача — не блокирует ответ
        postScreenshot(post_url, user_bot_id, abortController.signal, reqId)
            .then((result) => {
                log.success(logCtx, `YouTube timelapse завершён`);
            })
            .catch((error) => {
                log.error({ ...logCtx, err: error.message || error }, `YouTube timelapse ошибка`);
            });
        return;
    }

    // Надежный детект отвала клиента в Express
    res.on('close', () => {
        if (!res.writableEnded) {
            log.warn(logCtx, `Соединение закрыто клиентом до завершения. Triggering AbortSignal...`);
            abortController.abort();
        }
    });
    
    // Дублирующая проверка на случай жестких обрывов
    req.socket.on('error', () => {
        if (!res.writableEnded) {
            log.warn(logCtx, `Ошибка сокета клиента. Triggering AbortSignal...`);
            abortController.abort();
        }
    });

    try {
        const result = await postScreenshot(post_url, user_bot_id, abortController.signal, reqId) as IPostScreenshotResponse;
        
        // --- ЗАЩИТА ОТ ДУБЛИЙ (если клиент отвалился пока обрабатывался Playwright) ---
        // Проверяем и сигнал, и состояние сокета
        if (abortController.signal.aborted || req.socket.destroyed) {
            log.warn(logCtx, `Запрос был отменён клиентом, пропускаем отправку результата`);
            return;
        }

        if (!result.success) {
            return res.status(400).json(result);
        };

        // Уведомление в ТГ теперь только здесь, ПОСЛЕ всех проверок на отмену
        if (SETTINGS.SEND_TO_TELEGRAM && result.buffer) {
            notifyTelegram(result.buffer, post_url, order_id, channel_url, result.file_name);
            log.info(logCtx, `Уведомление успешно отправлено в Telegram`);
        }

        res.json({
            success: true,
            file_name: result.file_name
        });

    } catch (error: any) {
        if (req.socket.destroyed) return;

        log.error({ ...logCtx, err: error.message || String(error) }, `Ошибка создания скриншота`);

        res.status(error?.status || 500).json({
            success: false,
            code: 1004,
            message: "SCREENSHOT_FAILED",
            data: error.data || String(error),
        });
    }
};
