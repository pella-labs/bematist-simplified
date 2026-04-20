import type { EventEnvelope } from "@bematist/contracts";

export type EmitFn = (event: EventEnvelope) => void;
export type Stop = () => Promise<void>;

export interface Adapter {
  readonly name: string;
  start(emit: EmitFn): Promise<Stop>;
}

export interface AdapterContext {
  deviceId: string;
  clientVersion: string;
}

export type AdapterFactory = (ctx: AdapterContext) => Adapter;
