import importlib.util
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path

spec = importlib.util.spec_from_file_location('proxy', Path(__file__).parent / 'cloud/qq-model-fallback.py')
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


class Opener:
    def __init__(self, fail_first=False):
        self.requests = []
        self.fail_first = fail_first

    def open(self, request, timeout):
        self.requests.append((request.full_url, json.loads(request.data)))
        if self.fail_first and len(self.requests) == 1:
            raise urllib.error.HTTPError(request.full_url, 503, 'unavailable', {}, None)
        return object()


class RouteTests(unittest.TestCase):
    def test_lease_and_expiry(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'ledger.json'
            self.assertFalse(proxy.game_authorized(p, now=100))
            p.write_text('{"leaseUntil":101000}')
            self.assertTrue(proxy.game_authorized(p, now=100))
            self.assertFalse(proxy.game_authorized(p, now=101))
            p.write_text('{broken')
            self.assertFalse(proxy.game_authorized(p, now=100))

    def test_game_primary_only_and_tools_preserved(self):
        opener = Opener()
        body = {'model': 'deepseek-v4.1-flash', 'tools': [{'type': 'function'}]}
        _, route = proxy.perform(body, {'primary': 'p', 'fallback': 'f'}, opener, game=True)
        self.assertEqual(route, 'chream')
        self.assertEqual(opener.requests[0][1]['model'], 'deepseek-v4.1-flash')
        self.assertEqual(opener.requests[0][1]['tools'], body['tools'])
        failing = Opener(fail_first=True)
        with self.assertRaises(urllib.error.HTTPError):
            proxy.perform(body, {'primary': 'p', 'fallback': 'f'}, failing, game=True)
        self.assertEqual(len(failing.requests), 1)

    def test_non_game_original_primary_and_fallback(self):
        opener = Opener(fail_first=True)
        _, route = proxy.perform({'model': 'deepseek-v4.1-flash'}, {'primary': 'p', 'fallback': 'f'}, opener)
        self.assertEqual([x[0] for x in opener.requests], [proxy.PRIMARY, proxy.FALLBACK])
        self.assertEqual(route, 'qianwen')


if __name__ == '__main__':
    unittest.main()
