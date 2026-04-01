import { Request, Response } from "express";
import { z } from "zod";
import { postScreenshot } from "../../services";
import { log } from "../../utils";
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

    const { post_url, user_bot_id } = parsed.data;
    
    try {
        
        const result = await postScreenshot(post_url, user_bot_id);
        if (!result.success) {
            return res.status(400).json({
                ...result
            });
        };

        res.json({
            ...result
        });

    } catch (error: any) {
        log.error(`❌ Ошибка создания скриншота | Ссылка на пост: ${post_url} | Message: ${JSON.stringify(error)}`);

        res.status(error?.status || 500).json({
            success: false,
            code: 1004,
            message: "SCREENSHOT_FAILED",
            data: error.data || String(error),
        });
    }
};
