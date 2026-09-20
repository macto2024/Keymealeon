"""Loopback-only VS Code context bridge and deterministic six-key layouts."""
import json
import logging
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = logging.getLogger('keymaeleon6.vscode')

# action: (caption, pictogram)
ACTIONS = {
 'save': ('Save All','save'), 'tests': ('Run Tests','run'), 'find': ('Find','search'),
 'definition': ('Definition','definition'), 'scm': ('Source Control','git'),
 'terminal': ('Terminal','terminal'), 'problems': ('Problems','problem'),
 'copy': ('Copy','copy'), 'cut': ('Cut','cut'), 'comment': ('Comment','comment'),
 'references': ('References','definition'), 'format': ('Format Selection','format'),
 'next_problem': ('Next Problem','problem'), 'quickfix': ('Quick Fix','fix'),
 'prev_change': ('Previous Change','previous'), 'next_change': ('Next Change','next'),
 'stage': ('Stage File','stage'), 'open': ('Open File','files'),
 'review': ('Review Changes','diff'), 'review_staged': ('Review Staged','diff'),
 'unstage': ('Unstage File','unstage'), 'commit': ('Open Commit UI','commit'),
 'stop': ('Stop Tests','stop'), 'output': ('Test Output','terminal'),
 'codex': ('Ask Codex','codex'), 'idle': ('Unavailable','idle')}

# At most ten 5-pixel glyphs plus spacing fit the 64-pixel OLED width.
KEY_LABELS = {
 'save':'SAVE ALL', 'tests':'RUN TESTS', 'find':'FIND', 'definition':'DEFINITION',
 'scm':'GIT', 'terminal':'TERMINAL', 'problems':'PROBLEMS', 'copy':'COPY',
 'cut':'CUT', 'comment':'COMMENT', 'references':'REFERENCES', 'format':'FORMAT',
 'next_problem':'NEXT ERROR', 'quickfix':'QUICK FIX', 'prev_change':'PREV DIFF',
 'next_change':'NEXT DIFF', 'stage':'STAGE FILE', 'open':'OPEN FILE',
 'review':'REVIEW', 'review_staged':'STAGED', 'unstage':'UNSTAGE',
 'commit':'COMMIT UI', 'stop':'STOP TESTS', 'output':'OUTPUT', 'codex':'ASK CODEX',
 'idle':'OFF'}

def key_icon(item, labels=True):
    """Return an action-specific bitmap; shared by hardware and simulator."""
    if not labels:
        return item['icon']
    prefix = 'vscode_disabled_' if item['reason'] else 'vscode_'
    return prefix + item['id']


def layout(state):
    tests = state.get('tests', {}).get('state')
    git = state.get('git', {})
    if tests == 'running':
        ids = 'stop output problems open scm terminal'
    elif state.get('has_selection'):
        ids = 'copy codex comment references format save'
    elif state.get('unsaved_files'):
        ids = 'save tests codex scm terminal problems'
    elif tests == 'failed':
        ids = 'tests codex output open review scm'
    elif state.get('active_diagnostics'):
        ids = 'next_problem quickfix problems save tests codex'
    elif state.get('is_diff'):
        ids = ('review_staged unstage commit tests scm codex' if git.get('active_staged')
               and not git.get('active_modified') else 'prev_change next_change stage open tests scm')
    elif git.get('staged'):
        ids = 'review_staged unstage commit tests scm codex'
    elif git.get('active_modified'):
        ids = 'save tests review scm codex terminal'
    else:
        ids = 'save tests find scm terminal problems'
    result = []
    for action in ids.split():
        reason = ''
        # Run Tests stays actionable: the extension can detect tests or explain configuration.
        if action in ('review','stage') and not git.get('active_modified'): reason = 'No saved changes in active file'
        if action in ('review_staged','unstage') and not git.get('active_staged'): reason = 'Active file has no staged changes'
        if action in ('scm','commit') and not git.get('available'): reason = 'No Git repository'
        if action in ('definition','copy','cut','comment','references','format','open','next_problem','quickfix') and not state.get('active_file'): reason = 'No active file'
        label, icon = ACTIONS[action]
        result.append({'id':action, 'label':label, 'icon':icon if not reason else 'idle', 'reason':reason})
    return result

class Bridge:
    def __init__(self, port=5173):
        self.lock = threading.RLock()
        self.token = secrets.token_urlsafe(32)
        self.session = None
        self.state = {}
        self.last_seen = 0
        self.revision = 0
        self.pending = []
        self.inflight = {}
        self.last_action = ''
        bridge = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self):
                if self.headers.get('Origin') or self.headers.get('Host') not in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'):
                    return self.reply(403, {'error':'Local clients only'})
                if self.path != '/api/context': return self.reply(404, {'error':'Not found'})
                with bridge.lock:
                    context = {'project':bridge.state.get('root'), 'revision':bridge.revision,
                               'connected':time.monotonic()-bridge.last_seen <= 3,
                               'vscode':bridge.state, 'last_action':bridge.last_action}
                self.reply(200, {'token':bridge.token, 'context':context})
            def reply(self, status, data):
                body = json.dumps(data).encode()
                self.send_response(status); self.send_header('Content-Type','application/json')
                self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
            def do_POST(self):
                if self.headers.get('Origin') or not secrets.compare_digest(self.headers.get('X-Six-Token',''),bridge.token):
                    return self.reply(403, {'error':'Invalid token'})
                try:
                    length = int(self.headers.get('Content-Length',0))
                    if not 0 < length <= 262144: raise ValueError('Invalid payload size')
                    data = json.loads(self.rfile.read(length))
                    self.reply(200, bridge.handle(self.path,data))
                except (ValueError, KeyError, TypeError) as exc: self.reply(400, {'error':str(exc)})
        self.server = ThreadingHTTPServer(('127.0.0.1',port),Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
    def close(self):
        self.server.shutdown(); self.server.server_close()
    def handle(self, route, data):
        with self.lock:
            now = time.monotonic()
            expired = [key for key, command in self.inflight.items() if now-command['created'] > 5]
            for key in expired:
                del self.inflight[key]
                self.last_action = 'Action acknowledgement timed out; check VS Code'
            if route == '/api/editor/context':
                state = data['state']
                if not isinstance(state,dict) or not isinstance(data['session'],str): raise ValueError('Invalid context')
                # Only focused windows can take ownership; background heartbeats never reclaim it.
                if data['session'] != self.session:
                    if not state.get('focused'): return {'commands':[]}
                    self.session = data['session']; self.pending.clear(); self.inflight.clear(); self.revision += 1
                comparable = lambda value: {k:v for k,v in value.items() if k != 'focused'}
                if comparable(state) != comparable(self.state): self.revision += 1
                self.state = state; self.last_seen = now
                commands = [c for c in self.pending if c['revision'] == self.revision and now-c['created'] < 3]
                if self.pending and not commands:
                    self.last_action = 'Context changed; press an updated key'
                    LOG.info(self.last_action)
                self.pending.clear()
                self.inflight.update({c['id']:c for c in commands})
                return {'commands': commands}
            if route == '/api/editor/ack':
                if data['session'] != self.session: raise ValueError('Wrong session')
                command = self.inflight.pop(data['id'],None)
                if command:
                    self.last_action = data.get('error') or ('Done: '+command['action'])
                    LOG.info('VS Code: %s', self.last_action)
                return {}
            if route == '/api/editor/disconnect':
                if data['session'] == self.session: self.last_seen = 0; self.pending.clear()
                return {}
            raise ValueError('Unknown endpoint')
    def connection_reason(self):
        """Explain the unavailable editor without conflating it with firmware support."""
        with self.lock:
            if self.session is None:
                return 'No VS Code context received; reload VS Code, open a trusted local folder, then run SIX: Connect to Local Backend'
            if time.monotonic()-self.last_seen > 3:
                return 'VS Code bridge disconnected or heartbeat expired; check Output > Keymaeleon and six.backendUrl'
            if not self.state.get('focused'):
                return 'Waiting for VS Code window focus'
            return 'VS Code context available'

    def snapshot(self, allow_unfocused=False):
        with self.lock:
            if time.monotonic()-self.last_seen > 3 or (not allow_unfocused and not self.state.get('focused')): return None
            return self.revision, layout(self.state), dict(self.state)
    def press(self, revision, key, allow_unfocused=False):
        with self.lock:
            snapshot = self.snapshot(allow_unfocused)
            if not snapshot or snapshot[0] != revision or not 0 <= key < 6: return False
            item = snapshot[1][key]
            if item['reason']:
                self.last_action = item['reason']
                LOG.info('VS Code: %s', self.last_action)
                return False
            if self.pending or self.inflight: return False
            self.pending.append({'id':secrets.token_hex(8),'action':item['id'], 'revision':revision,
                                 'file': self.state.get('active_file'), 'allow_unfocused':allow_unfocused, 'created':time.monotonic()})
            self.last_action = 'Queued: '+item['label']
            LOG.info('VS Code: %s', self.last_action)
            return True
