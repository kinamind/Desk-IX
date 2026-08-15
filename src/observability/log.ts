type LogLevel = "info" | "warn" | "error";

const sensitiveKeyPattern = /token|secret|authorization|api[_-]?key/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => redact(entry, depth + 1));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = sensitiveKeyPattern.test(key) ? "[redacted]" : redact(entry, depth + 1);
    }
    return output;
  }
  if (typeof value === "string" && value.length > 1000) return `${value.slice(0, 1000)}…`;
  return value;
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, event, ...redact(fields) as Record<string, unknown> });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
