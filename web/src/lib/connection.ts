import { getCombatLog, getDecisions, getPendingRolls, getRolls, getSettings } from './api';
import { backoffMs, type GameStore, type ServerMessage } from './store.svelte';

/** Subscribes to /ws for one campaign and keeps the store fed; returns a disposer. */
export function connectLive(store: GameStore, campaignId: number): () => void {
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let disposed = false;

  const subscribe = () => socket?.send(JSON.stringify({ type: 'subscribe', campaignId }));

  const refreshRolls = () => {
    getRolls(campaignId)
      .then((rows) => store.setRolls(rows))
      .catch(() => undefined);
  };

  /** On every connect: what the player owns (settings) and what the DM is waiting on. */
  const loadPlayerState = () => {
    getSettings(campaignId)
      .then((settings) => store.setSettings(settings))
      .catch(() => undefined);
    getPendingRolls(campaignId)
      .then((rows) => store.prompts.setOpen(rows))
      .catch(() => undefined);
    getDecisions(campaignId)
      .then((rows) => store.decisions.setOpen(rows))
      .catch(() => undefined);
  };

  const loadCombatLog = () => {
    getCombatLog(campaignId)
      .then((rows) => store.combat.seedHistory(rows))
      .catch(() => {
        store.combat.clearHistoryRequest();
        console.warn('Failed to load the fight log; will retry.');
      });
  };

  const open = () => {
    store.status = 'connecting';
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${scheme}://${location.host}/ws`);

    socket.addEventListener('open', () => {
      attempt = 0;
      store.status = 'live';
      subscribe();
      refreshRolls();
      loadPlayerState();
    });
    socket.addEventListener('message', (message) => {
      const action = store.apply(JSON.parse(String(message.data)) as ServerMessage);
      if (action === 'resubscribe') subscribe();
      if (action === 'refresh-rolls') refreshRolls();
      if (action === 'load-combat-log') loadCombatLog();
    });
    socket.addEventListener('close', () => {
      if (disposed) return;
      store.status = 'offline';
      timer = setTimeout(open, backoffMs(attempt++));
    });
    socket.addEventListener('error', () => socket?.close());
  };

  store.resubscribe = () => {
    subscribe();
    refreshRolls();
    loadPlayerState();
  };

  open();

  return () => {
    disposed = true;
    store.resubscribe = null;
    clearTimeout(timer);
    socket?.close();
  };
}
