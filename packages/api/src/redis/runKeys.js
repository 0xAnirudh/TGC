/**
 * Redis keys for a live run.
 *
 * A run is hot state: read on every screen, written on every action,
 * and worthless once the run ends. It lives in Redis while active and is
 * written down to Mongo when it finishes.
 */
export const runState = (runId) => `run:${runId}`;
export const runCargo = (runId) => `run:${runId}:cargo`;

/**
 * Net units traded per town per good, today.
 *
 * This is what makes buying in bulk cost more: the price a player pays
 * depends on how much they have already moved here today. Deleted on
 * every day change, because tomorrow is a new set of prices.
 */
export const runFlow = (runId) => `run:${runId}:flow`;

/** The one active run per player, so a reload finds its way back. */
export const activeRun = (userId) => `user:${userId}:run`;
