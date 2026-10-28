import type { Channel, ChannelAdapter } from '../types.js';
import { instagram } from './instagram.js';

// Adding Facebook (Phase 1b) = write channels/facebook.ts and register it here. The core does not change.
const adapters = new Map<Channel, ChannelAdapter>([[instagram.channel, instagram]]);

export function registerAdapter(a: ChannelAdapter) {
  adapters.set(a.channel, a);
}

export function getAdapter(channel: Channel): ChannelAdapter {
  const a = adapters.get(channel);
  if (!a) throw new Error(`No adapter for channel ${channel}`);
  return a;
}
