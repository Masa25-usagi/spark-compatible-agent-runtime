type RouteHandler = (params: Record<string, string>) => HTMLElement | Promise<HTMLElement>;

export class Router {
  private routes: { pattern: RegExp; handler: RouteHandler }[] = [];
  private root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    window.addEventListener('hashchange', () => this.handleRoute());
  }

  add(pattern: RegExp, handler: RouteHandler) {
    this.routes.push({ pattern, handler });
  }

  async handleRoute() {
    const hash = window.location.hash.slice(1) || '/';
    const path = hash.split('?')[0] || '/';
    for (const route of this.routes) {
      const match = path.match(route.pattern);
      if (match) {
        const params = match.groups || {};
        this.root.innerHTML = '';
        const el = await route.handler(params);
        this.root.appendChild(el);
        return;
      }
    }
    this.root.innerHTML = '<h2>404 Not Found</h2>';
  }

  navigate(path: string) {
    window.location.hash = path;
  }
}
