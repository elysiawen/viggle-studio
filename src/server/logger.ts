type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, event: string, context?: Record<string, unknown>): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...context,
  };
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

export const logger = {
  debug: (event: string, context?: Record<string, unknown>) => emit("debug", event, context),
  info: (event: string, context?: Record<string, unknown>) => emit("info", event, context),
  warn: (event: string, context?: Record<string, unknown>) => emit("warn", event, context),
  error: (event: string, context?: Record<string, unknown>) => emit("error", event, context),
  child: (scope: string) => ({
    debug: (event: string, context?: Record<string, unknown>) =>
      emit("debug", `${scope}.${event}`, context),
    info: (event: string, context?: Record<string, unknown>) =>
      emit("info", `${scope}.${event}`, context),
    warn: (event: string, context?: Record<string, unknown>) =>
      emit("warn", `${scope}.${event}`, context),
    error: (event: string, context?: Record<string, unknown>) =>
      emit("error", `${scope}.${event}`, context),
  }),
};
