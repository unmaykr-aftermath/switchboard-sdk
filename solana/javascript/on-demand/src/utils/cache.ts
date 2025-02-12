import QuickLRU from "quick-lru";

/**
 *  Cache for gateway ping responses.
 *
 *  A value of true means that the gateway is healthy.
 */
export const GATEWAY_PING_CACHE = new QuickLRU<string, boolean>({
  maxSize: 50,
  maxAge: 100,
});
