import type { EventContext } from '@z-cloudbase/contracts';

// Server-derived event context (PRD §21.7): coarse browser / OS / device class from User-Agent and the
// country Cloudflare resolved for the connection. No versions, no raw UA, nothing read from the body.

const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|preview|curl|wget|python-requests|node-fetch/i;

export function parseUserAgent(ua: string | null | undefined): Pick<EventContext, 'browser' | 'os' | 'device'> {
  if (!ua) return { browser: 'other', os: 'other', device: 'desktop' };
  if (BOT_RE.test(ua)) return { browser: 'bot', os: 'other', device: 'bot' };
  const browser =
    /Edg(e|A|iOS)?\//.test(ua) ? 'edge'
      : /OPR\/|Opera/.test(ua) ? 'opera'
        : /SamsungBrowser\//.test(ua) ? 'samsung'
          : /Firefox\/|FxiOS\//.test(ua) ? 'firefox'
            : /Chrome\/|CriOS\/|Chromium\//.test(ua) ? 'chrome'
              : /Version\/[\d.]+.*Safari\//.test(ua) || /(iPhone|iPad|iPod).*AppleWebKit/.test(ua) ? 'safari'
                : 'other';
  const os =
    /iPhone|iPad|iPod/.test(ua) ? 'ios'
      : /Android/.test(ua) ? 'android'
        : /CrOS/.test(ua) ? 'chromeos'
          : /Windows/.test(ua) ? 'windows'
            : /Mac OS X|Macintosh/.test(ua) ? 'macos'
              : /Linux/.test(ua) ? 'linux'
                : 'other';
  const device =
    /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? 'tablet'
      : /Mobi|iPhone|iPod|Android.*Mobile/.test(ua) ? 'mobile'
        : 'desktop';
  return { browser, os, device };
}

/** Context of an ingest request; service-key requests are backend calls, so they carry no device context. */
export function requestContext(req: Request, kind: 'publishable' | 'service'): EventContext {
  if (kind === 'service') return { source: 'server', browser: '', os: '', device: '', country: '' };
  const cf = (req as Request & { cf?: { country?: unknown } }).cf;
  const country = typeof cf?.country === 'string' && /^[A-Z]{2}$/.test(cf.country) ? cf.country : '';
  return { source: 'client', ...parseUserAgent(req.headers.get('user-agent')), country };
}
