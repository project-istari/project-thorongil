/**
 * A small, polite MediaWiki API client.
 *
 * Points at the Command & Conquer Fandom wiki by default, but any MediaWiki
 * install works — mirrors and self-hosted copies included — which matters
 * because Fandom is not reachable from every network.
 */

export interface WikiClientOptions {
  /** api.php endpoint. */
  endpoint?: string;
  /** Milliseconds between requests. The API asks for serial, unhurried access. */
  delayMs?: number;
  userAgent?: string;
  maxRetries?: number;
}

export interface WikiPage {
  pageid: number;
  title: string;
  wikitext: string;
  categories: string[];
  /**
   * Lead image URL, when the wiki has one registered for the page.
   *
   * Contributed as a fact like cost or prose: the page shows it, the engine
   * never reasons about it.
   */
  image?: string;
  /**
   * The title we asked for, when it differs from the title we got.
   *
   * MediaWiki silently follows normalisation and redirects, so asking for
   * "Crusader_Tank" returns a page titled "Crusader tank". The curated dataset
   * joins on the title it recorded, so that original has to survive the trip.
   */
  requestedTitle?: string;
}

export const DEFAULT_ENDPOINT = 'https://cnc.fandom.com/api.php';

export class WikiBlockedError extends Error {
  constructor(readonly host: string, readonly detail: string) {
    super(
      `Cannot reach ${host}: ${detail}\n` +
      `This is a network/egress restriction, not a bug in the crawler.\n` +
      `Options:\n` +
      `  - run the ingest from a network that allows ${host}\n` +
      `  - point it at a mirror:  npm run ingest -- --endpoint https://<mirror>/api.php\n` +
      `  - skip it entirely: the curated dataset in data/curated/ works offline.`,
    );
    this.name = 'WikiBlockedError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WikiClient {
  private readonly endpoint: string;
  private readonly delayMs: number;
  private readonly userAgent: string;
  private readonly maxRetries: number;
  private lastRequest = 0;

  requestCount = 0;

  constructor(opts: WikiClientOptions = {}) {
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.delayMs = opts.delayMs ?? 250;
    this.userAgent = opts.userAgent ?? 'battle-lineup/0.1 (Zero Hour skirmish planner; offline dataset builder)';
    this.maxRetries = opts.maxRetries ?? 3;
  }

  get host(): string {
    return new URL(this.endpoint).host;
  }

  private async throttle(): Promise<void> {
    const since = Date.now() - this.lastRequest;
    if (since < this.delayMs) await sleep(this.delayMs - since);
    this.lastRequest = Date.now();
  }

  /** One API call, with retries on transient failures and a clear error when blocked. */
  async query<T = unknown>(params: Record<string, string>): Promise<T> {
    const url = new URL(this.endpoint);
    for (const [k, v] of Object.entries({ format: 'json', formatversion: '2', maxlag: '5', ...params })) {
      url.searchParams.set(k, v);
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.throttle();
      this.requestCount++;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': this.userAgent, Accept: 'application/json' } });

        if (res.status === 403 || res.status === 407) {
          throw new WikiBlockedError(this.host, `HTTP ${res.status} from the network proxy`);
        }
        if (res.status === 429 || res.status >= 500) {
          lastError = new Error(`HTTP ${res.status}`);
          await sleep(2 ** attempt * 1000);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

        const body = (await res.json()) as { error?: { code: string; info: string } } & T;
        if (body.error) {
          // maxlag is the server asking us to wait, not a failure.
          if (body.error.code === 'maxlag') {
            await sleep(2 ** attempt * 1000);
            continue;
          }
          throw new Error(`API error ${body.error.code}: ${body.error.info}`);
        }
        return body;
      } catch (err) {
        if (err instanceof WikiBlockedError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|CONNECT tunnel|403|fetch failed/i.test(msg)) {
          throw new WikiBlockedError(this.host, msg);
        }
        lastError = err;
        await sleep(2 ** attempt * 500);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Every page in a category, following continuation. */
  async categoryMembers(category: string, limit = 500): Promise<Array<{ pageid: number; title: string }>> {
    const out: Array<{ pageid: number; title: string }> = [];
    let cont: string | undefined;

    do {
      const res = await this.query<{
        query?: { categorymembers: Array<{ pageid: number; title: string }> };
        continue?: { cmcontinue: string };
      }>({
        action: 'query',
        list: 'categorymembers',
        cmtitle: category.startsWith('Category:') ? category : `Category:${category}`,
        cmlimit: String(Math.min(limit, 500)),
        cmnamespace: '0',
        ...(cont ? { cmcontinue: cont } : {}),
      });
      out.push(...(res.query?.categorymembers ?? []));
      cont = res.continue?.cmcontinue;
    } while (cont && out.length < limit);

    return out;
  }

  /** Full-text search, for finding pages that categories missed. */
  async search(term: string, limit = 50): Promise<Array<{ pageid: number; title: string }>> {
    const res = await this.query<{ query?: { search: Array<{ pageid: number; title: string }> } }>({
      action: 'query',
      list: 'search',
      srsearch: term,
      srlimit: String(Math.min(limit, 500)),
      srnamespace: '0',
    });
    return res.query?.search ?? [];
  }

  /**
   * Page wikitext, categories and lead image, up to 50 titles per call.
   *
   * `redirects=1` is what makes the curated dataset's page titles usable: many
   * of them ("Crusader_Tank", "Scorpion tank") are redirects to the real
   * article. The API reports every normalisation and redirect it followed, and
   * we thread the originally requested title back onto the page so the caller
   * can still join it against the record that asked for it.
   */
  async fetchPages(titles: string[]): Promise<WikiPage[]> {
    // Keyed by page id, because several requested titles can land on one page:
    // "Kassad" from a category crawl and "Prince Kassad" from the curated seed
    // are the same article. Whichever copy carries a requestedTitle is the one
    // worth keeping — it is the only one that can join to a curated record.
    const byId = new Map<number, WikiPage>();
    const out: WikiPage[] = [];
    for (let i = 0; i < titles.length; i += 50) {
      const batch = titles.slice(i, i + 50);
      const res = await this.query<{
        query?: {
          normalized?: Array<{ from: string; to: string }>;
          redirects?: Array<{ from: string; to: string }>;
          pages: Array<{
            pageid: number;
            title: string;
            missing?: boolean;
            revisions?: Array<{ slots: { main: { content: string } } }>;
            categories?: Array<{ title: string }>;
            original?: { source: string };
            thumbnail?: { source: string };
          }>;
        };
      }>({
        action: 'query',
        titles: batch.join('|'),
        prop: 'revisions|categories|pageimages',
        rvprop: 'content',
        rvslots: 'main',
        cllimit: '500',
        piprop: 'original|thumbnail',
        pithumbsize: '800',
        redirects: '1',
      });

      // Walk requested -> normalised -> redirected so a final title can name
      // the title we actually asked for. Both hops are optional and either can
      // chain, so resolve iteratively rather than assuming one step.
      const hop = new Map<string, string>();
      for (const n of res.query?.normalized ?? []) hop.set(n.to, n.from);
      for (const r of res.query?.redirects ?? []) hop.set(r.to, r.from);
      const origin = (title: string): string => {
        let cur = title;
        for (let step = 0; step < 8; step++) {
          const prev = hop.get(cur);
          if (prev === undefined || prev === cur) break;
          cur = prev;
        }
        return cur;
      };

      for (const p of res.query?.pages ?? []) {
        if (p.missing) continue;
        const requested = origin(p.title);
        const image = p.original?.source ?? p.thumbnail?.source;
        const page: WikiPage = {
          pageid: p.pageid,
          title: p.title,
          wikitext: p.revisions?.[0]?.slots.main.content ?? '',
          categories: (p.categories ?? []).map((c) => c.title.replace(/^Category:/, '')),
          ...(image ? { image } : {}),
          ...(requested !== p.title ? { requestedTitle: requested } : {}),
        };
        const seen = byId.get(p.pageid);
        if (!seen) {
          byId.set(p.pageid, page);
          out.push(page);
        } else if (!seen.requestedTitle && page.requestedTitle) {
          seen.requestedTitle = page.requestedTitle;
        }
      }
    }
    return out;
  }
}
