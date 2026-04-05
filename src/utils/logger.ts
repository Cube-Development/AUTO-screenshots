import pino from 'pino';

export const pinoLogger = pino({
  level: process.env.LOG_LEVEL || 'debug',
  // transport: {
  //   target: 'pino-pretty',
  //   options: {
  //     colorize: true,
  //   },
  // },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: null,
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
});

export const log = {
  info: (objOrMsg: any, msg?: string) => 
    msg ? pinoLogger.info(objOrMsg, msg) : pinoLogger.info(objOrMsg),
    
  error: (objOrMsg: any, msg?: string) => {
    if (msg) {
        pinoLogger.error({ ...objOrMsg, category: '❌ ERROR' }, msg);
    } else {
        pinoLogger.error({ category: '❌ ERROR' }, objOrMsg);
    }
  },
    
  warn: (objOrMsg: any, msg?: string) => {
    if (msg) {
        pinoLogger.warn({ ...objOrMsg, category: '⚠️ WARN' }, msg);
    } else {
        pinoLogger.warn({ category: '⚠️ WARN' }, objOrMsg);
    }
  },
    
  success: (objOrMsg: any, msg?: string) => {
    if (msg) {
        pinoLogger.info({ ...objOrMsg, category: '✅ SUCCESS' }, msg);
    } else {
        pinoLogger.info({ category: '✅ SUCCESS' }, objOrMsg);
    }
  },
    
  debug: (objOrMsg: any, msg?: string) => 
    msg ? pinoLogger.debug(objOrMsg, msg) : pinoLogger.debug(objOrMsg),

  api: (objOrMsg: any, msg?: string) => {
    if (msg) {
        pinoLogger.info({ ...objOrMsg, category: 'API' }, msg);
    } else {
        pinoLogger.info({ category: 'API' }, objOrMsg);
    }
  },

};

