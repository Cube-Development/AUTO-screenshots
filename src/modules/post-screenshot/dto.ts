import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from "zod";
import { ENUM_REGISTER_ROUTE } from '../../utils/swagger/register.enum';

extendZodWithOpenApi(z);

// Регулярное выражение для Instagram и Telegram URL
const telegramRegex = /^https:\/\/t\.me\//;
const instagramRegex = /^https:\/\/www\.instagram\.com/; // убрали /p/
const youtubeRegex = /^https:\/\/(www\.)?youtube\.com\/watch|^https:\/\/youtu\.be\//;

export const PostScreenShotSchema = z.object({
  post_url: z.string()
    .min(1)
    .refine((url) => telegramRegex.test(url) || instagramRegex.test(url) || youtubeRegex.test(url), {
      message: "URL должен быть для Telegram (https://t.me/), Instagram (https://www.instagram.com/) или YouTube (https://youtube.com/watch)",
    })
    .openapi({
      description: "URL для скриншота (Telegram, Instagram или YouTube)",
      example: "https://www.instagram.com/reel/DQHfm-FiNrG/?igsh=c2ZpNG4wYXU0a3dx",
    }),
  user_bot_id: z.string().optional().openapi({
    description: "ID бота Telegram для авторизации",
    example: "7697061334",
  })
    })
  .openapi(ENUM_REGISTER_ROUTE.POST_SCREENSHOT)