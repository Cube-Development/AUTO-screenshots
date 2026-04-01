import { OpenAPIRegistry, OpenApiGeneratorV3, RouteConfig } from '@asteasolutions/zod-to-openapi';
import { SWAGGER_ROUTES, SWAGGER_SCHEMAS } from './config';

// Создаем реестр
const registry = new OpenAPIRegistry();

// Регистрируем все схемы
SWAGGER_SCHEMAS.forEach(({ name, schema }) => {
  registry.register(name, schema);
});

// Регистрируем все роуты
SWAGGER_ROUTES.forEach(route => {
  registry.registerPath(route as RouteConfig);
});

// Генерируем OpenAPI документ
const generator = new OpenApiGeneratorV3(registry.definitions);

const baseDocument = generator.generateDocument({
  openapi: '3.0.0',
  info: {
    title: 'e-imzo-sign-server API',
    version: '1.0.0',
    description: 'Документация API для сервиса подписи документов'
  }
});

// Добавляем схемы безопасности
export const openApiDocument = {
  ...baseDocument,
  components: {
    ...baseDocument.components,
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'API ключ для доступа к защищенным эндпоинтам'
      }
    }
  },
  security: [
    {
      ApiKeyAuth: []
    }
  ]
};