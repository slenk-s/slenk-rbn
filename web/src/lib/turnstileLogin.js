export function createTurnstileLoginFlow() {
  let challengeToken = null;

  return {
    completeChallenge(token) {
      challengeToken = typeof token === 'string' && token.trim() ? token : null;
    },
    token() {
      return challengeToken;
    },
    stage(pathname) {
      return pathname === '/login' && challengeToken !== null ? 'login' : 'challenge';
    },
    invalidate() {
      challengeToken = null;
    }
  };
}
