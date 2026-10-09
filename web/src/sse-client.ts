export class SSEClient {
  private eventSource: EventSource | null = null;
  private url: string;
  private listeners: Map<string, Set<(data: any) => void>> = new Map();

  constructor(url: string = '/api/v1/events') {
    this.url = url;
  }

  connect() {
    this.eventSource = new EventSource(this.url);
    this.eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        const type = data.type || 'message';
        this.emit(type, data);
      } catch (err) {
        console.error('SSE Parse error', err);
      }
    };
  }

  on(type: string, callback: (data: any) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(callback);
  }

  emit(type: string, data: any) {
    this.listeners.get(type)?.forEach((cb) => cb(data));
  }
}
