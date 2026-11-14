const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TOKEN_MAX_LENGTH = 2048;
const SITEVERIFY_TIMEOUT_MS = 10_000;

function redact(value, token, secret) {
  return typeof value === 'string' && !value.includes(token) && !value.includes(secret)
    ? value
    : undefined;
}

const DIAGNOSTIC_REASONS = new Set([
  'invalid_token',
  'invalid_config',
  'siteverify_transport',
  'siteverify_rejected',
  'action_mismatch',
  'hostname_mismatch',
]);
const DIAGNOSTIC_ERROR_CODES = new Set([
  'missing-input-secret',
  'invalid-input-secret',
  'missing-input-response',
  'invalid-input-response',
  'bad-request',
  'timeout-or-duplicate',
  'internal-error',
]);
const DIAGNOSTIC_ACTION_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const DIAGNOSTIC_HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const SUSPICIOUS_DIAGNOSTIC_VALUE = /token|secret|password|credential/i;

function isSafeDiagnosticString(value, pattern) {
  return typeof value === 'string' &&
    pattern.test(value) &&
    !SUSPICIOUS_DIAGNOSTIC_VALUE.test(value);
}

export function formatTurnstileDiagnostic(result) {
  const diagnostic = {};
  if (DIAGNOSTIC_REASONS.has(result?.reason)) diagnostic.reason = result.reason;
  if (!result?.details || typeof result.details !== 'object' || Array.isArray(result.details)) {
    return diagnostic;
  }

  const details = {};
  const { status, errorCodes, action, hostname } = result.details;
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    details.status = status;
  }
  if (Array.isArray(errorCodes)) {
    const safeErrorCodes = errorCodes.filter(
      (code) => typeof code === 'string' && DIAGNOSTIC_ERROR_CODES.has(code),
    );
    if (safeErrorCodes.length > 0) details.errorCodes = safeErrorCodes;
  }
  if (isSafeDiagnosticString(action, DIAGNOSTIC_ACTION_PATTERN)) details.action = action;
  if (isSafeDiagnosticString(hostname, DIAGNOSTIC_HOSTNAME_PATTERN)) details.hostname = hostname;

  if (Object.keys(details).length > 0) diagnostic.details = details;
  return diagnostic;
}

export function shouldLogTurnstileFailure(result) {
  return result?.ok === false && result.reason !== 'invalid_token';
}

export async function verifyTurnstile({
  token,
  secret,
  expectedAction,
  expectedHostnames,
  remoteIp,
  fetchImpl = fetch,
}) {
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > TOKEN_MAX_LENGTH
  ) {
    return { ok: false, reason: 'invalid_token' };
  }
  if (
    typeof secret !== 'string' ||
    secret.length === 0 ||
    expectedAction !== 'login' ||
    !(expectedHostnames instanceof Set) ||
    expectedHostnames.size === 0 ||
    [...expectedHostnames].some(
      (hostname) => typeof hostname !== 'string' || hostname.length === 0,
    )
  ) {
    return { ok: false, reason: 'invalid_config' };
  }

  const body = new URLSearchParams({ secret, response: token });
  if (typeof remoteIp === 'string' && remoteIp.length > 0) {
    body.set('remoteip', remoteIp);
  }

  let response;
  let result;
  try {
    response = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
      body,
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: 'siteverify_transport',
        details: { status: response.status },
      };
    }
    result = await response.json();
  } catch {
    return { ok: false, reason: 'siteverify_transport' };
  }

  if (result?.success !== true) {
    const errorCodes = Array.isArray(result?.['error-codes'])
      ? result['error-codes']
        .map((code) => redact(code, token, secret))
        .filter((code) => code !== undefined)
      : [];
    return {
      ok: false,
      reason: 'siteverify_rejected',
      details: { errorCodes },
    };
  }
  if (result.action !== 'login') {
    return {
      ok: false,
      reason: 'action_mismatch',
      details: { action: redact(result.action, token, secret) },
    };
  }
  if (
    typeof result.hostname !== 'string' ||
    result.hostname.length === 0 ||
    !expectedHostnames.has(result.hostname)
  ) {
    return {
      ok: false,
      reason: 'hostname_mismatch',
      details: { hostname: redact(result.hostname, token, secret) },
    };
  }

  return { ok: true };
}
