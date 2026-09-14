import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { getToken } from './api.js';

/**
 * Live prices over the WebSocket.
 *
 * Returns a map of goodId -> latest update. The server coalesces
 * broadcasts into 250ms batches, so this updates at most four times a
 * second however busy the market is.
 *
 * `watch` is optional: pass a good id to join that good's room and get
 * its individual updates, or leave it out to receive only the market-wide
 * summary.
 */
export function useLivePrices(watch) {
  const [live, setLive] = useState({});

  useEffect(() => {
    const socket = io({ auth: { token: getToken() ?? undefined } });

    const apply = (updates) => {
      const list = Array.isArray(updates) ? updates : [updates];
      setLive((prev) => {
        const next = { ...prev };
        for (const u of list) next[u.goodId] = u;
        return next;
      });
    };

    socket.on('market', apply);
    socket.on('price', apply);
    if (watch) socket.emit('watch', watch);

    return () => {
      if (watch) socket.emit('unwatch', watch);
      socket.disconnect();
    };
  }, [watch]);

  return live;
}
