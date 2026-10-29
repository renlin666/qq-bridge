"""Authenticated loopback proxy for the administrator's DeepSeek route.

主路由走 Chream 中转（deepseek-v4.1-flash），失败时回退千问 MaaS；
2026-10-27 起按管理员要求去掉 DeepSeek 官方 API 兜底（api.deepseek.com 已下线）。

Fallback occurs only before response headers are sent; it never replays a
partially streamed response or a completed game/tool action.
"""
import hmac
import http.server
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import yaml

PRIMARY = 'https://www.chream.me/v1/chat/completions'
FALLBACK = 'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions'
RETRY_STATUS = frozenset((401, 402, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504))
MAX_REQUEST = 16 * 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def game_authorized(ledger_path=None, now=None):
    """The game lease is written atomically by the bridge; never inspect its contents in logs."""
    path = ledger_path or Path(__file__).resolve().parents[2] / 'state/sts2/ledger.json'
    try:
        state = json.loads(path.read_text(encoding='utf-8'))
        return float(state.get('leaseUntil', 0)) > (time.time() if now is None else now) * 1000
    except (OSError, ValueError, TypeError, AttributeError):
        return False


def perform(body, keys, opener=None, *, game=False):
    """Return (stream, endpoint) or raise the last upstream error."""
    if not isinstance(body, dict) or body.get('model') not in ('deepseek-flash', 'deepseek-v4.1-flash'):
        raise ValueError('unsupported model')
    opener = opener or urllib.request.build_opener(NoRedirect)
    routes = [(PRIMARY, keys['primary'], 'deepseek-v4.1-flash', 'chream'),
              (FALLBACK, keys['fallback'], 'deepseek-v4.1-flash', 'qianwen')]
    if game:
        routes = routes[:1]
    for index, (url, key, model, name) in enumerate(routes):
        data = dict(body, model=model)
        request = urllib.request.Request(url, data=json.dumps(data, ensure_ascii=False).encode('utf-8'),
            headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'})
        try:
            result = opener.open(request, timeout=180)
            return result, name
        except urllib.error.HTTPError as error:
            if index + 1 < len(routes) and error.code in RETRY_STATUS:
                error.close()
                continue
            raise
        except (urllib.error.URLError, TimeoutError, OSError):
            if index + 1 < len(routes):
                continue
            raise
    raise RuntimeError('no upstream available')


def credentials():
    home = Path(os.environ.get('DSH_HOME', '/var/lib/qq-stack/dsh'))
    refs = yaml.safe_load((home / '.credentials.yaml').read_text(encoding='utf-8')).get('refs', {})
    result = {'primary': refs.get('qq_chream_fallback', ''),
              'fallback': refs.get('QQ_QIANWEN_API_KEY', ''), 'proxy': refs.get('qq_deepseek_proxy_token', '')}
    if any(not isinstance(x, str) or len(x) < 24 for x in result.values()):
        raise RuntimeError('model credentials not configured')
    return result


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        if self.path != '/chat/completions':
            return self.send_error(404)
        sent = False
        try:
            keys = credentials()
            if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + keys['proxy']):
                return self.send_error(403)
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_REQUEST:
                return self.send_error(413)
            body = json.loads(self.rfile.read(length))
            game = game_authorized()
            upstream, source = perform(body, keys, game=game)
            self.send_response(upstream.status)
            self.send_header('Content-Type', upstream.headers.get('Content-Type', 'application/json'))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.end_headers()
            sent = True
            print('model route: ' + source + (' (game)' if game else ''), file=sys.stderr, flush=True)
            with upstream:
                while True:
                    chunk = upstream.read1(8192)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except urllib.error.HTTPError as error:
            self.send_error(error.code, 'upstream model unavailable')
        except (ValueError, TypeError, json.JSONDecodeError):
            self.send_error(400, 'invalid request')
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            print('model proxy error: ' + type(error).__name__, file=sys.stderr, flush=True)
            if not sent:
                try:
                    self.send_error(503, 'model unavailable')
                except Exception:
                    pass


if __name__ == '__main__':
    credentials()
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 23931), Handler)
    server.daemon_threads = True
    server.serve_forever()
