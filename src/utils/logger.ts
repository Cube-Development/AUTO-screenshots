import chalk from 'chalk';

const getTimestamp = () => {
  const now = new Date();
  const time = now.toLocaleTimeString('ru-RU', { hour12: false });
  const date = now.toLocaleDateString('ru-RU');
  return `${date} ${time}`;
};

const formatMessage = (level: string, icon: string, color: any, message: string) => {
  const timestamp = chalk.gray(`[${getTimestamp()}]`);
  const levelTag = color(`[${level.padEnd(7)}]`);
  return `${timestamp} ${levelTag} ${icon} ${message}`;
};

export const log = {
  info: (message: string) => 
    console.log(formatMessage('INFO', '📋', chalk.blue, message)),
    
  error: (message: string) => 
    console.error(formatMessage('ERROR', '💥', chalk.red, chalk.red(message))),
    
  warn: (message: string) => 
    console.warn(formatMessage('WARN', '⚠️', chalk.yellow, chalk.yellow(message))),
    
  success: (message: string) => 
    console.log(formatMessage('SUCCESS', '✅', chalk.green, chalk.green(message))),
    
  debug: (message: string) => 
    console.log(formatMessage('DEBUG', '🔍', chalk.magenta, chalk.dim(message))),

  websocket: (message: string) => 
    console.log(formatMessage('WS', '🔌', chalk.cyan, message)),

  api: (message: string) => 
    console.log(formatMessage('API', '🌐', chalk.blue, message)),

  crypto: (message: string) => 
    console.log(formatMessage('CRYPTO', '🔐', chalk.magenta, message))
};