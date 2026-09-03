import type { Destinations, Resolution } from "./types";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class PupitreClient {
  constructor(private baseUrl: string, private token: string, private fetcher: Fetcher = fetch) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const fetcher = this.fetcher;
    const response = await fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}`, ...init.headers },
    });
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(body.error || `Pupitre répond ${response.status}`);
    return body as T;
  }

  resolve(origin: string, pathname: string): Promise<Resolution> {
    return this.request("/api/visual-feedback/resolve", { method: "POST", body: JSON.stringify({ origin, pathname }) });
  }

  destinations(projectId: string): Promise<Destinations> {
    return this.request(`/api/visual-feedback/projects/${encodeURIComponent(projectId)}/destinations`);
  }

  associate(origin: string, pathname: string, projectId: string): Promise<{ ok: true }> {
    return this.request("/api/visual-feedback/origins", {
      method: "PUT", body: JSON.stringify({ origin, pathPrefix: pathname || "/", projectId }),
    });
  }

  submit(payload: unknown): Promise<{ conversationId: string; projectId: string }> {
    return this.request("/api/visual-feedback/submissions", { method: "POST", body: JSON.stringify(payload) });
  }
}
