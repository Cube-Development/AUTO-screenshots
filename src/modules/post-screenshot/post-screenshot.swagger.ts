import { PostScreenShotSchema } from "./dto";
import { ROUTES_SCREENSHOT } from "./post-screenshot.routes";

export const CreatePostScreenShotSwagger = {
  method: 'post',
  path: `${ROUTES_SCREENSHOT.BASE}${ROUTES_SCREENSHOT.POST_SCREENSHOT}`, 
  summary: 'Создать скриншот',
  description: 'Создает скриншот по URL',
  tags: ['Скриншоты постов'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: PostScreenShotSchema
        }
      }
    }
  },
  responses: {
    200: {
      description: 'Скриншот успешно создан',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
               file_name: { type: 'string', example: 'File.png' },
            
            }
          }
        }
        }
    },
    400: {
      description: 'Ошибка обработки URL или при создании скриншота',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              code: {
                type: 'number',
                enum: [1002, 1003, 1004],
                example: 1002
              },
              message: {
                type: 'string',
                enum: ['PRIVATE_ACCOUNT_INSTAGRAM', 'UNSUPPORTED_URL', 'SCREENSHOT_FAILED'],
                example: 'PRIVATE_ACCOUNT_INSTAGRAM'
              }
            },
            required: ['success', 'code', 'message']
          }
        }
      }
    },
    422: {
      description: 'Ошибка валидации',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
               code: {
                type: 'number',
                example: 1001
              },
              message: {
                type: 'string',
                example: 'VALIDATION_ERROR'
              },
              errors: {
                type: 'object',
                additionalProperties: {
                  type: 'array',
                  items: { type: 'string' }
                },
                example: {
                  post_url: ['post_url is required', 'URL должен начинаться с https://t.me/ или https://www.instagram.com']
                }
              }
            }
          }
        }
      }
}
}
}