import { PRODUCTION_AGENT_URL, resolveAgentUrl } from '../agentSocket';

/**
 * Release builds used to fall back to ws://localhost:3001 — the phone itself —
 * so the Agent tab could never connect. These pin the replacement down.
 */
describe('resolveAgentUrl', () => {
  it('uses the hosted agent in a release build when nothing is configured', () => {
    expect(resolveAgentUrl(undefined, false)).toBe(PRODUCTION_AGENT_URL);
    expect(resolveAgentUrl('   ', false)).toBe(PRODUCTION_AGENT_URL);
    expect(PRODUCTION_AGENT_URL.startsWith('wss://')).toBe(true);
  });

  it('keeps localhost for development', () => {
    expect(resolveAgentUrl(undefined, true)).toBe('ws://localhost:3001');
  });

  it('respects a configured secure URL as-is', () => {
    expect(resolveAgentUrl('wss://agent.example.com', false)).toBe('wss://agent.example.com');
  });

  it('upgrades plaintext to anything but a local host — the socket carries transactions', () => {
    expect(resolveAgentUrl('ws://agent.example.com:8080/path', false)).toBe(
      'wss://agent.example.com:8080/path',
    );
  });

  it('leaves plaintext alone for local and LAN development hosts', () => {
    for (const url of [
      'ws://localhost:3001',
      'ws://127.0.0.1:3001',
      'ws://10.0.2.2:3001',
      'ws://192.168.1.20:3001',
    ]) {
      expect(resolveAgentUrl(url, true)).toBe(url);
    }
  });

  it('falls back instead of opening a socket to something that is not a URL', () => {
    expect(resolveAgentUrl('not a url', false)).toBe(PRODUCTION_AGENT_URL);
  });
});
