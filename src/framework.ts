// Framework / platform detection — pure, RAM-only, zero deps.
// Inspects ExposureInput fields (routes, resources, urls, params,
// reqHeaders, resHeaders) and emits bounded, deduplicated findings.
//
// Conventions follow exposure.ts: lowercase matching, URL parsing with a
// plain-string fallback, defensive per-record try/catch so one malformed
// record can never throw, and a hard cap so huge sessions stay small.

import type { ExposureFinding, ExposureInput } from './exposure.js';

const MAX_FINDINGS = 60;
const KIND = 'framework';

/** Conditional-CVE table keyed by framework slug. Only entries with a
 *  verified identifier belong here; wording must stay conditional because
 *  the running version is almost never visible in these input fields. */
const CVE_TABLE: ReadonlyArray<{
  slug: string;
  cve: string;
  title: string;
  affected: string;
  rule: string;
}> = [
  {
    slug: 'nextjs',
    cve: 'CVE-2025-66478',
    title: 'React Flight RCE',
    affected: '15.x/16.x',
    rule: 'fw-cve-next-flight',
  },
];

function lower(s: unknown): string {
  try {
    return typeof s === 'string' ? s.toLowerCase() : '';
  } catch {
    return '';
  }
}

function hostOf(url: unknown): string {
  try {
    if (typeof url !== 'string' || !url) return '';
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

interface UrlRec {
  raw: string;
  low: string;
  host: string;
}

interface ReqRec {
  url: string;
  host: string;
  keys: string[];
  values: string[];
}

interface ResRec {
  url: string;
  host: string;
  mime: string;
  names: string[];
  values: string[];
}

interface Ctx {
  urlPool: UrlRec[];
  routePool: string[];
  paramSet: Set<string>;
  reqEntries: ReqRec[];
  resEntries: ResRec[];
  versions: Map<string, string>;
}

function buildCtx(input: ExposureInput): Ctx {
  const ctx: Ctx = {
    urlPool: [],
    routePool: [],
    paramSet: new Set<string>(),
    reqEntries: [],
    resEntries: [],
    versions: new Map<string, string>(),
  };
  let safe: ExposureInput;
  try {
    safe = (input ?? {}) as ExposureInput;
  } catch {
    return ctx;
  }

  try {
    for (const r of (safe.resources ?? []) as Array<{ url?: unknown }>) {
      try {
        if (!r || typeof r.url !== 'string' || !r.url) continue;
        ctx.urlPool.push({ raw: r.url, low: lower(r.url), host: hostOf(r.url) });
      } catch {
        continue;
      }
    }
  } catch {
    /* ignore */
  }

  try {
    for (const u of (safe.urls ?? []) as unknown[]) {
      try {
        if (typeof u !== 'string' || !u) continue;
        ctx.urlPool.push({ raw: u, low: lower(u), host: hostOf(u) });
      } catch {
        continue;
      }
    }
  } catch {
    /* ignore */
  }

  try {
    for (const r of (safe.routes ?? []) as Array<{ route?: unknown }>) {
      try {
        if (!r || typeof r.route !== 'string' || !r.route) continue;
        ctx.routePool.push(lower(r.route));
      } catch {
        continue;
      }
    }
  } catch {
    /* ignore */
  }

  try {
    for (const p of (safe.params ?? []) as unknown[]) {
      try {
        if (typeof p !== 'string' || !p) continue;
        ctx.paramSet.add(p.toLowerCase());
      } catch {
        continue;
      }
    }
  } catch {
    /* ignore */
  }

  try {
    for (const e of (safe.reqHeaders ?? []) as Array<{ url?: unknown; headers?: unknown }>) {
      try {
        if (!e || typeof e !== 'object') continue;
        const url = typeof e.url === 'string' ? e.url : '';
        const keys: string[] = [];
        const values: string[] = [];
        try {
          const h = (e.headers ?? {}) as Record<string, unknown>;
          for (const k of Object.keys(h)) {
            try {
              keys.push(k.toLowerCase());
              const v = (h as Record<string, unknown>)[k];
              if (typeof v === 'string') values.push(v.toLowerCase());
            } catch {
              continue;
            }
          }
        } catch {
          /* ignore */
        }
        ctx.reqEntries.push({ url, host: hostOf(url), keys, values });
        if (url) ctx.urlPool.push({ raw: url, low: lower(url), host: hostOf(url) });
      } catch {
        continue;
      }
    }
  } catch {
    /* ignore */
  }

  try {
    for (const e of (safe.resHeaders ?? []) as Array<{ url?: unknown; mime?: unknown; headers?: unknown }>) {
      try {
        if (!e || typeof e !== 'object') continue;
        const url = typeof e.url === 'string' ? e.url : '';
        const mime = lower(e.mime);
        const names: string[] = [];
        const values: string[] = [];
        try {
          const h = (e.headers ?? {}) as Record<string, unknown>;
          for (const k of Object.keys(h)) {
            try {
              names.push(k.toLowerCase());
              const v = (h as Record<string, unknown>)[k];
              if (typeof v === 'string') values.push(v.toLowerCase());
            } catch {
              continue;
            }
          }
        } catch {
          /* ignore */
        }
        ctx.resEntries.push({ url, host: hostOf(url), mime, names, values });
        if (url) ctx.urlPool.push({ raw: url, low: lower(url), host: hostOf(url) });
      } catch {
        continue;
      }
    }
  } catch {
    /* ignore */
  }

  // Honest version extraction only: a version is recorded solely when the
  // input explicitly ties it to the framework (generator header naming the
  // framework, or a core-asset query string). Anything else stays unknown.
  try {
    for (const r of ctx.resEntries) {
      try {
        for (let i = 0; i < r.names.length; i++) {
          try {
            const n = r.names[i] ?? '';
            const v = r.values[i] ?? '';
            if (n !== 'x-generator' && n !== 'x-powered-by') continue;
            let m: RegExpExecArray | null = null;
            try {
              m = /wordpress\s+(\d+\.\d+(?:\.\d+)?)/i.exec(v);
            } catch {
              m = null;
            }
            if (m && !ctx.versions.has('wordpress')) ctx.versions.set('wordpress', m[1]);
            try {
              m = /drupal\s+(\d+(?:\.\d+){0,2})/i.exec(v);
            } catch {
              m = null;
            }
            if (m && !ctx.versions.has('drupal')) ctx.versions.set('drupal', m[1]);
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }
    for (const u of ctx.urlPool) {
      try {
        const m = /wp-includes\/[^?#]*[?&]ver=(\d+\.\d+(?:\.\d+)?)/i.exec(u.raw);
        if (m && !ctx.versions.has('wordpress')) ctx.versions.set('wordpress', m[1]);
      } catch {
        continue;
      }
    }
  } catch {
    /* ignore */
  }

  return ctx;
}

type Emitter = (
  rule: string,
  host: string,
  sev: ExposureFinding['sev'],
  label: string,
  text: string,
  url: string,
  route: string,
) => void;

function makeEmitter(out: ExposureFinding[], seen: Set<string>): Emitter {
  return (rule, host, sev, label, text, url, route) => {
    try {
      if (out.length >= MAX_FINDINGS) return;
      const key = String(rule) + '' + String(host || '');
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ sev, label, text, url: url || '', route: route || '', kind: KIND, rule });
    } catch {
      /* never throw from emit */
    }
  };
}

function full(): boolean {
  return false;
}

function detectNextjs(ctx: Ctx, emit: Emitter, out: ExposureFinding[]): void {
  try {
    const perHost = new Map<string, { url: string; sig: string }>();
    const note = (host: string, url: string, sig: string, rank: number): void => {
      try {
        const prev = perHost.get(host);
        if (!prev) {
          perHost.set(host, { url, sig: sig + ':' + String(rank) });
          return;
        }
        const prevRank = Number((prev.sig.split(':')[1] ?? '9'));
        if (rank < prevRank) perHost.set(host, { url: url || prev.url, sig: sig + ':' + String(rank) });
        else if (!prev.url && url) perHost.set(host, { url, sig: prev.sig });
      } catch {
        /* ignore */
      }
    };
    try {
      for (const u of ctx.urlPool) {
        try {
          if (out.length >= MAX_FINDINGS) return;
          if (u.low.includes('/_next/static/')) note(u.host, u.raw, 'static', 1);
          else if (u.low.includes('/_next/data/') || u.low.includes('__next_data__')) note(u.host, u.raw, 'data', 2);
        } catch {
          continue;
        }
      }
    } catch {
      /* ignore */
    }
    try {
      for (const rt of ctx.routePool) {
        try {
          if (out.length >= MAX_FINDINGS) return;
          if (rt.includes('/_next/static/')) note('', '', 'static', 1);
          else if (rt.includes('/_next/data/') || rt.includes('__next_data__')) note('', '', 'data', 2);
        } catch {
          continue;
        }
      }
    } catch {
      /* ignore */
    }
    try {
      for (const r of ctx.resEntries) {
        try {
          if (out.length >= MAX_FINDINGS) return;
          if (r.mime.includes('text/x-component')) note(r.host, r.url, 'rsc', 3);
          for (const v of r.values) {
            try {
              if (v.includes('next.js')) {
                note(r.host, r.url, 'powered', 5);
                break;
              }
            } catch {
              continue;
            }
          }
        } catch {
          continue;
        }
      }
    } catch {
      /* ignore */
    }
    try {
      for (const q of ctx.reqEntries) {
        try {
          if (out.length >= MAX_FINDINGS) return;
          if (q.keys.includes('next-action')) note(q.host, q.url, 'actions', 4);
        } catch {
          continue;
        }
      }
    } catch {
      /* ignore */
    }
    try {
      for (const [host, ev] of perHost) {
        try {
          if (out.length >= MAX_FINDINGS) return;
          const sig = (ev.sig.split(':')[0] ?? 'static');
          let text = 'Next.js detected via _next/static assets, version not exposed externally.';
          if (sig === 'data') text = 'Next.js detected via Next.js data routes, version not exposed externally.';
          else if (sig === 'rsc')
            text =
              'Next.js App Router activity detected via React Server Components responses, version not exposed externally.';
          else if (sig === 'actions')
            text = 'Next.js Server Actions detected via next-action request headers, version not exposed externally.';
          else if (sig === 'powered')
            text = 'Next.js detected via server response headers, version not exposed externally.';
          emit('fw-nextjs', host, 'info', 'Next.js framework detected', text, ev.url, '');
        } catch {
          continue;
        }
      }
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
}

function detectWordpress(ctx: Ctx, emit: Emitter, out: ExposureFinding[]): void {
  try {
    const perHost = new Map<string, { url: string; route: string; json: boolean }>();
    const note = (host: string, url: string, route: string, json: boolean): void => {
      try {
        const prev = perHost.get(host);
        if (!prev) {
          perHost.set(host, { url, route, json });
          return;
        }
        perHost.set(host, {
          url: prev.url || url,
          route: prev.route || route,
          json: prev.json || json,
        });
      } catch {
        /* ignore */
      }
    };
    try {
      for (const u of ctx.urlPool) {
        try {
          if (out.length >= MAX_FINDINGS) return;
          if (u.low.includes('/wp-json/')) note(u.host, u.raw, '', true);
          else if (u.low.includes('/wp-content/') || u.low.includes('/wp-includes/')) note(u.host, u.raw, '', false);
        } catch {
          continue;
        }
      }
    } catch {
      /* ignore */
    }
    try {
      for (const rt of ctx.routePool) {
        try {
          if (out.length >= MAX_FINDINGS) return;
          if (rt.includes('/wp-json/')) note('', '', rt, true);
          else if (rt.includes('/wp-content/') || rt.includes('/wp-includes/')) note('', '', rt, false);
        } catch {
          continue;
        }
      }
    } catch {
      /* ignore */
    }
    const ver = ctx.versions.get('wordpress') ?? '';
    try {
      for (const [host, ev] of perHost) {
        try {
          if (out.length >= MAX_FINDINGS) return;
          if (ev.json) {
            const text = ver
              ? 'WordPress ' +
                ver +
                ' detected via wp-json routes that may expose user enumeration by default.'
              : 'WordPress detected via wp-json routes that may expose user enumeration by default, version not exposed externally.';
            emit('fw-wordpress', host, 'medium', 'WordPress detected', text, ev.url, ev.route);
          } else {
            const text = ver
              ? 'WordPress ' + ver + ' detected via wp-content assets.'
              : 'WordPress detected via wp-content assets, version not exposed externally.';
            emit('fw-wordpress', host, 'info', 'WordPress detected', text, ev.url, ev.route);
          }
        } catch {
          continue;
        }
      }
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
}

function detectSimpleUrlFrameworks(ctx: Ctx, emit: Emitter, out: ExposureFinding[]): void {
  try {
    const groups: Array<{
      rule: string;
      label: string;
      text: string;
      test: (low: string, host: string) => boolean;
    }> = [
      {
        rule: 'fw-drupal',
        label: 'Drupal detected',
        text: 'Drupal detected via site file paths or response headers, version not exposed externally.',
        test: (low) => {
          try {
            if (low.includes('/sites/default/')) return true;
            if (low.includes('drupal') && (low.includes('/core/') || low.includes('drupal.js'))) return true;
            return false;
          } catch {
            return false;
          }
        },
      },
      {
        rule: 'fw-nuxt',
        label: 'Nuxt detected',
        text: 'Nuxt detected via _nuxt build assets, version not exposed externally.',
        test: (low) => {
          try {
            return low.includes('/_nuxt/') || low.includes('__nuxt');
          } catch {
            return false;
          }
        },
      },
      {
        rule: 'fw-sveltekit',
        label: 'SvelteKit detected',
        text: 'SvelteKit detected via immutable app bundles or data endpoints, version not exposed externally.',
        test: (low) => {
          try {
            return low.includes('/_app/immutable/') || low.includes('__data.json') || low.includes('sveltekit');
          } catch {
            return false;
          }
        },
      },
      {
        rule: 'fw-astro',
        label: 'Astro detected',
        text: 'Astro detected via _astro build assets, version not exposed externally.',
        test: (low) => {
          try {
            return low.includes('/_astro/');
          } catch {
            return false;
          }
        },
      },
      {
        rule: 'fw-laravel',
        label: 'Laravel detected',
        text: 'Laravel detected via sanctum or session markers, version not exposed externally.',
        test: (low) => {
          try {
            return low.includes('/sanctum/csrf-cookie') || low.includes('laravel');
          } catch {
            return false;
          }
        },
      },
      {
        rule: 'fw-vite',
        label: 'Vite tooling detected',
        text: 'Vite build tooling detected via development client URLs.',
        test: (low) => {
          try {
            return low.includes('/@vite/') || low.includes('.vite');
          } catch {
            return false;
          }
        },
      },
      {
        rule: 'fw-webpack',
        label: 'Webpack bundling detected',
        text: 'Webpack bundling detected via chunk file naming patterns.',
        test: (low) => {
          try {
            if (low.includes('.chunk.js')) return true;
            if (low.includes('vendors~') || low.includes('runtime~')) return true;
            if (low.includes('commons.chunk')) return true;
            try {
              return /chunk-[a-f0-9]{4,}\.js/.test(low);
            } catch {
              return false;
            }
          } catch {
            return false;
          }
        },
      },
    ];

    for (const g of groups) {
      try {
        if (out.length >= MAX_FINDINGS) return;
        const perHost = new Map<string, string>();
        try {
          for (const u of ctx.urlPool) {
            try {
              if (out.length >= MAX_FINDINGS) break;
              if (g.test(u.low, u.host) && !perHost.has(u.host)) perHost.set(u.host, u.raw);
            } catch {
              continue;
            }
          }
        } catch {
          /* ignore */
        }
        try {
          for (const rt of ctx.routePool) {
            try {
              if (out.length >= MAX_FINDINGS) break;
              if (g.test(rt, '') && !perHost.has('')) perHost.set('', '');
            } catch {
              continue;
            }
          }
        } catch {
          /* ignore */
        }
        // Drupal also advertises itself via cache headers and generator strings.
        if (g.rule === 'fw-drupal') {
          try {
            for (const r of ctx.resEntries) {
              try {
                if (out.length >= MAX_FINDINGS) break;
                let hit = false;
                for (const n of r.names) {
                  try {
                    if (n === 'x-drupal-cache' || n === 'x-drupal-dynamic-cache') {
                      hit = true;
                      break;
                    }
                  } catch {
                    continue;
                  }
                }
                if (!hit) {
                  for (const v of r.values) {
                    try {
                      if (v.includes('drupal')) {
                        hit = true;
                        break;
                      }
                    } catch {
                      continue;
                    }
                  }
                }
                if (hit && !perHost.has(r.host)) perHost.set(r.host, r.url);
              } catch {
                continue;
              }
            }
          } catch {
            /* ignore */
          }
        }
        // Laravel also leaves session-cookie markers in response headers.
        if (g.rule === 'fw-laravel') {
          try {
            for (const r of ctx.resEntries) {
              try {
                if (out.length >= MAX_FINDINGS) break;
                let hit = false;
                for (const v of r.values) {
                  try {
                    if (v.includes('laravel_session') || v.includes('xsrf-token')) {
                      hit = true;
                      break;
                    }
                  } catch {
                    continue;
                  }
                }
                if (hit && !perHost.has(r.host)) perHost.set(r.host, r.url);
              } catch {
                continue;
              }
            }
          } catch {
            /* ignore */
          }
        }
        let text = g.text;
        try {
          if (g.rule === 'fw-drupal') {
            const ver = ctx.versions.get('drupal') ?? '';
            if (ver) text = 'Drupal ' + ver + ' detected via site file paths or response headers.';
          }
        } catch {
          /* keep default text */
        }
        try {
          for (const [host, url] of perHost) {
            try {
              if (out.length >= MAX_FINDINGS) return;
              emit(g.rule, host, 'info', g.label, text, url, '');
            } catch {
              continue;
            }
          }
        } catch {
          /* ignore */
        }
      } catch {
        continue;
      }
    }
  } catch {
    /* ignore */
  }
}

function detectParamFrameworks(ctx: Ctx, emit: Emitter, out: ExposureFinding[]): void {
  try {
    try {
      if (ctx.paramSet.has('csrfmiddlewaretoken')) {
        if (out.length < MAX_FINDINGS) {
          emit(
            'fw-django',
            '',
            'info',
            'Django detected',
            'Django detected via csrfmiddlewaretoken parameter, version not exposed externally.',
            '',
            '',
          );
        }
      } else {
        for (const r of ctx.resEntries) {
          try {
            if (out.length >= MAX_FINDINGS) break;
            let hit = false;
            for (const v of r.values) {
              try {
                if (v.includes('csrftoken')) {
                  hit = true;
                  break;
                }
              } catch {
                continue;
              }
            }
            if (hit) {
              emit(
                'fw-django',
                r.host,
                'info',
                'Django detected',
                'Django detected via csrftoken session cookie, version not exposed externally.',
                r.url,
                '',
              );
            }
          } catch {
            continue;
          }
        }
      }
    } catch {
      /* ignore */
    }
    try {
      if (ctx.paramSet.has('authenticity_token')) {
        if (out.length < MAX_FINDINGS) {
          emit(
            'fw-rails',
            '',
            'info',
            'Ruby on Rails detected',
            'Ruby on Rails detected via authenticity_token parameter, version not exposed externally.',
            '',
            '',
          );
        }
      } else {
        for (const u of ctx.urlPool) {
          try {
            if (out.length >= MAX_FINDINGS) break;
            if (u.low.includes('authenticity_token')) {
              emit(
                'fw-rails',
                u.host,
                'info',
                'Ruby on Rails detected',
                'Ruby on Rails detected via authenticity_token parameter, version not exposed externally.',
                u.raw,
                '',
              );
            }
          } catch {
            continue;
          }
        }
      }
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
}

function detectProviders(ctx: Ctx, emit: Emitter, out: ExposureFinding[]): void {
  try {
    const defs: Array<{
      rule: string;
      label: string;
      text: string;
      test: (low: string, host: string) => boolean;
    }> = [
      {
        rule: 'fw-firebase',
        label: 'Firebase backend detected',
        text: 'Firebase backend in use via observed database, storage, or hosting URLs.',
        test: (_low, host) => {
          try {
            return (
              host.endsWith('firebaseio.com') || host.includes('firebasestorage') || host.endsWith('firebaseapp.com')
            );
          } catch {
            return false;
          }
        },
      },
      {
        rule: 'fw-supabase',
        label: 'Supabase backend detected',
        text: 'Supabase backend in use via observed project URLs.',
        test: (low, host) => {
          try {
            return host.endsWith('supabase.co') || low.includes('supabase.co');
          } catch {
            return false;
          }
        },
      },
      {
        rule: 'fw-stripe',
        label: 'Stripe.js detected',
        text: 'Stripe payment library loaded from observed script URLs.',
        test: (low) => {
          try {
            return low.includes('js.stripe.com') || low.includes('stripe.js');
          } catch {
            return false;
          }
        },
      },
      {
        rule: 'fw-algolia',
        label: 'Algolia detected',
        text: 'Algolia search service in use via observed API URLs.',
        test: (low, host) => {
          try {
            return host.includes('algolia') || low.includes('algolia');
          } catch {
            return false;
          }
        },
      },
      {
        rule: 'fw-sanity',
        label: 'Sanity CMS detected',
        text: 'Sanity CMS in use via observed API URLs.',
        test: (low, host) => {
          try {
            return host.includes('sanity.io') || low.includes('sanity.io');
          } catch {
            return false;
          }
        },
      },
      {
        rule: 'fw-contentful',
        label: 'Contentful CMS detected',
        text: 'Contentful CMS in use via observed API or asset URLs.',
        test: (low, host) => {
          try {
            return host.includes('contentful.com') || host.includes('ctfassets.net') || low.includes('ctfassets.net');
          } catch {
            return false;
          }
        },
      },
    ];
    for (const d of defs) {
      try {
        if (out.length >= MAX_FINDINGS) return;
        const perHost = new Map<string, string>();
        for (const u of ctx.urlPool) {
          try {
            if (out.length >= MAX_FINDINGS) break;
            if (d.test(u.low, u.host) && !perHost.has(u.host)) perHost.set(u.host, u.raw);
          } catch {
            continue;
          }
        }
        for (const [host, url] of perHost) {
          try {
            if (out.length >= MAX_FINDINGS) return;
            emit(d.rule, host, 'info', d.label, d.text, url, '');
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    /* ignore */
  }
}

function detectConditionalCves(
  ctx: Ctx,
  nextjsSeen: boolean,
  firstNextjsUrl: string,
  emit: Emitter,
  out: ExposureFinding[],
): void {
  try {
    if (!nextjsSeen) return;
    if (out.length >= MAX_FINDINGS) return;
    for (const entry of CVE_TABLE) {
      try {
        if (out.length >= MAX_FINDINGS) return;
        if (entry.slug !== 'nextjs') continue;
        const text =
          'Possible ' +
          entry.cve +
          ' ' +
          entry.title +
          ' exposure if this Next.js app runs unpatched ' +
          entry.affected +
          ', so confirm the running version — affected only if ' +
          entry.affected +
          ' unpatched.';
        emit(entry.rule, '', 'high', 'Conditional CVE: Next.js Flight RCE', text, firstNextjsUrl, '');
      } catch {
        continue;
      }
    }
    void ctx;
  } catch {
    /* ignore */
  }
}

/**
 * Derive bounded framework / provider findings from discovered
 * routes/resources/urls/params/headers. Pure: no I/O, no globals.
 * Capped at 60 findings, deduplicated by rule+host, and every record
 * access is guarded so malformed input cannot throw.
 */
export function findFrameworkFindings(input: ExposureInput): ExposureFinding[] {
  const out: ExposureFinding[] = [];
  const seen = new Set<string>();
  try {
    void full;
    const ctx = buildCtx(input);
    const emit = makeEmitter(out, seen);
    try {
      detectNextjs(ctx, emit, out);
    } catch {
      /* ignore */
    }
    try {
      detectWordpress(ctx, emit, out);
    } catch {
      /* ignore */
    }
    try {
      detectSimpleUrlFrameworks(ctx, emit, out);
    } catch {
      /* ignore */
    }
    try {
      detectParamFrameworks(ctx, emit, out);
    } catch {
      /* ignore */
    }
    try {
      detectProviders(ctx, emit, out);
    } catch {
      /* ignore */
    }
    try {
      let nextjsSeen = false;
      let firstNextjsUrl = '';
      for (const f of out) {
        try {
          if (f && f.rule === 'fw-nextjs') {
            nextjsSeen = true;
            if (!firstNextjsUrl && typeof f.url === 'string') firstNextjsUrl = f.url;
            break;
          }
        } catch {
          continue;
        }
      }
      detectConditionalCves(ctx, nextjsSeen, firstNextjsUrl, emit, out);
    } catch {
      /* ignore */
    }
  } catch {
    /* return whatever was collected */
  }
  try {
    return out.slice(0, MAX_FINDINGS);
  } catch {
    return [];
  }
}
