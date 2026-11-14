import { EventEmitter } from "node:events";
import type { StreamEvent } from "@/lib/types";

type Listener = (event: StreamEvent) => void;

class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // SSE 连接可能很多，取消 Node 默认的 10 个监听器告警
    this.emitter.setMaxListeners(0);
  }

  publish(event: StreamEvent): void {
    this.emitter.emit("event", event);
  }

  subscribe(listener: Listener): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  get listenerCount(): number {
    return this.emitter.listenerCount("event");
  }
}

// 生产构建会把模块打进不同 chunk，必须无条件共享同一个实例，
// 否则一个 Route 发布的事件另一个 Route 的 SSE 连接收不到。
const globalForBus = globalThis as unknown as { __viggleEventBus?: EventBus };
export const eventBus = globalForBus.__viggleEventBus ?? new EventBus();
globalForBus.__viggleEventBus = eventBus;

export function publish(event: StreamEvent): void {
  eventBus.publish(event);
}

/**
 * 创建 SSE 流。先建立订阅再发送快照，避免订阅与快照之间丢事件。
 * 连接断开（abort / cancel）时清理订阅与心跳定时器。
 */
export function createEventStream(options: {
  signal: AbortSignal;
  heartbeatMs?: number;
  onConnect: (send: (event: StreamEvent) => void) => void;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  let unsubscribe: () => void = () => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    if (timer) clearInterval(timer);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: StreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          );
        } catch {
          cleanup();
        }
      };

      unsubscribe = eventBus.subscribe(send);
      timer = setInterval(() => send({ type: "heartbeat", at: Date.now() }), heartbeatMs);
      options.signal.addEventListener("abort", cleanup, { once: true });
      options.onConnect(send);
    },
    cancel: cleanup,
  });
}
