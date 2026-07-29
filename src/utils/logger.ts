import { LOG_LEVEL } from "../config";

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: number = LEVELS[(LOG_LEVEL as Level) ?? "info"] ?? 1;

function ts(): string {
  return new Date().toISOString();
}

function log(level: Level, msg: string, meta?: unknown): void {
  if (LEVELS[level] < currentLevel) return;
  const line =
    meta !== undefined
      ? `[${ts()}] [${level.toUpperCase()}] ${msg} ${JSON.stringify(meta)}`
      : `[${ts()}] [${level.toUpperCase()}] ${msg}`;
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const logger = {
  debug: (msg: string, meta?: unknown) => log("debug", msg, meta),
  info: (msg: string, meta?: unknown) => log("info", msg, meta),
  warn: (msg: string, meta?: unknown) => log("warn", msg, meta),
  error: (msg: string, meta?: unknown) => log("error", msg, meta),
};
