import Fastify, { LogController } from 'fastify';
import { ZodError } from 'zod';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';

export function createHttpApp(config: Config) {
  const app = Fastify({
    logger:
      config.logLevel === 'silent'
        ? false
        : { level: config.logLevel, redact: ['req.headers.authorization', 'req.headers.cookie'] },
    bodyLimit: 32768,
    requestTimeout: 120000,
    logController: new LogController({ disableRequestLogging: true }),
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError)
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: {
          code: 'validation',
          message: error.issues[0]?.message || 'Перевірте параметри запиту.',
        },
      });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return reply.code(status).send({
        error: {
          code: `http_${status}`,
          message:
            status === 429 ? 'Забагато запитів. Спробуйте трохи пізніше.' : 'Некоректний запит.',
        },
      });
    app.log.error({ type: (error as Error).name }, 'Request failed');
    return reply.code(500).send({
      error: { code: 'internal', message: 'Не вдалося виконати запит. Спробуйте ще раз.' },
    });
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
  });
  return app;
}
