import type { EventsPort, EventSink, HarnessEvent } from '../contracts/events.ts'
import { EventsKey } from '../contracts/keys.ts'
import type { Plugin } from '../kernel/plugin.ts'

export class MemoryEvents implements EventsPort {
  readonly #sinks = new Set<EventSink>()

  emit(event: HarnessEvent): void {
    for (const sink of this.#sinks) {
      try {
        sink(event)
      } catch {
        // 观察者异常不能影响主控制流。
      }
    }
  }

  subscribe(sink: EventSink): () => void {
    this.#sinks.add(sink)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.#sinks.delete(sink)
    }
  }
}

export function eventsPlugin(): Plugin {
  return {
    name: 'events',
    provides: [EventsKey],
    setup(scope) {
      scope.provide(EventsKey, new MemoryEvents())
    },
  }
}
