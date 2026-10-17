// Commands, filenames and model text are untrusted terminal content.
export function safeText(text) {
  return String(text)
    .replace(/\x1b\][^\x07]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

export function write(text) { process.stdout.write(safeText(text)); }

export function redactDiagnostics(text, env = process.env) {
  let value = safeText(text);
  for (const [key, secret] of Object.entries(env)) if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/i.test(key) && secret?.length >= 4) value = value.replaceAll(secret, '[REDACTED]');
  return value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]');
}
