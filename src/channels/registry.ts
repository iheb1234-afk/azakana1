import type { Channel, ChannelAdapter } from '../types.js';
import { facebook } from './facebook.js';
import { instagram } from './instagram.js';

// Adding a channel = write channels/<name>.ts and register it here. The core does not change.
const adapters = new Map<Channel, ChannelAdapter>([
  [instagram.channel, instagram],
  [facebook.channel, facebook],
]);

export function registerAdapter(a: ChannelAdapter) {
  adapters.set(a.channel, a);
}

export function getAdapter(channel: Channel): ChannelAdapter {
  const a = adapters.get(channel);
  if (!a) throw new Error(`No adapter for channel ${channel}`);
  return a;
}
