import winston from 'winston';
import path from 'path';

const logFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss'
  }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.prettyPrint()
);

// Create transports array - exclude console for MCP mode
const transports: winston.transport[] = [
  new winston.transports.File({
    filename: path.join(process.cwd(), 'logs', 'error.log'),
    level: 'error',
    maxsize: 10485760, // 10MB
    maxFiles: 5,
  }),
  // File transport for all logs
  new winston.transports.File({
    filename: path.join(process.cwd(), 'logs', 'combined.log'),
    maxsize: 10485760, // 10MB
    maxFiles: 5,
  })
];

// Add console transport only if not running as MCP server
if (!process.env.MCP_MODE) {
  transports.unshift(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports,
});

// Handle uncaught exceptions
logger.exceptions.handle(
  new winston.transports.File({
    filename: path.join(process.cwd(), 'logs', 'exceptions.log')
  })
);

process.on('unhandledRejection', (ex) => {
  throw ex;
});
