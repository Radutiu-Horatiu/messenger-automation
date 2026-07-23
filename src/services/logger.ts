import pino from "pino";
import { config } from "../config.js";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: config.logging.level,
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss",
            ignore: "pid,hostname",
          },
        },
      }),
});

export type Logger = typeof logger;
