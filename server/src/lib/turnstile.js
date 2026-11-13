const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TOKEN_MAX_LENGTH = 2048;
const SITEVERIFY_TIMEOUT_MS = 10_000;

function redact(value, token, secret) {
  return typeof value === 'string' && !value.includes(token) && !value.includes(secret)
    ? value
    : undefined;
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
    token.length > TOKEN_MAX_LENGTH ||
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
