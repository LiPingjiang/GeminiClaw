// src/channels/registry.ts
// Channel registry — load, start, and stop all registered channels.
import type { IChannel, ChannelContext } from "./types.js";

export class ChannelRegistry {
  private channels: IChannel[] = [];

  register(channel: IChannel): void {
    this.channels.push(channel);
  }

  async startAll(ctx: ChannelContext): Promise<void> {
    for (const channel of this.channels) {
      await channel.start(ctx);
    }
  }

  async stopAll(): Promise<void> {
    for (const channel of this.channels) {
      await channel.stop();
    }
  }
}
