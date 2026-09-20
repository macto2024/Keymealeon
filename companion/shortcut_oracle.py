#!/usr/bin/env python3
"""OpenAI-backed key suggestions for apps with no preset six-key layout.

Lookups run on daemon threads so the serial loop never blocks. Results are kept in
memory for the life of the process only: a restart asks the model again.
"""
import json
import logging
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import namedtuple
from pathlib import Path

LOG = logging.getLogger('keymaeleon6.llm')
STREAM = sys.stderr  # Raw prompt/completion text goes where the log lines go.
STREAM_LOCK = threading.Lock()
HOME = Path(__file__).resolve().parent
ENDPOINT = 'https://api.openai.com/v1/chat/completions'
DEFAULT_MODEL = 'gpt-4o-mini'
KEY_COUNT = 6
LABEL_MAX = 24  # Must match LABEL_MAX in Keymaeleon6/Keymaeleon6.ino.
RETRY_AFTER = 300  # Seconds before a failed app is asked about again.
MAX_REQUESTS = 50  # Session budget; a window title that keeps changing must not bill forever.
MIN_INTERVAL = 3  # Seconds between lookups, so flicking through apps does not burst requests.
MAX_OUTPUT = 1500  # Ceiling, not a target: reasoning models spend most of it before writing.
DEFAULT_REASONING = 'none'  # Six known shortcuts need no deliberation, and thinking is billed.
REASONING_LEVELS = ('none', 'minimal', 'low', 'medium', 'high')
REASONING_FALLBACK = {'none': 'minimal'}  # If a model has no "none", ask for the least it offers.
PARAMETER_RENAMES = {'max_tokens': 'max_completion_tokens'}  # Newer models moved this one.
KEYSYM = re.compile(r'^[A-Za-z0-9_]+$')
WINDOW_ID = re.compile(r'^(0x[0-9a-fA-F]+|\d+)$')
MODIFIERS = {'ctrl', 'alt', 'shift', 'super', 'meta'}
IDLE_NAMES = {'', '-', '--', 'idle', 'none', 'null', 'unknown', 'other'}
# X keysym names for the punctuation that real shortcuts use: ctrl+/ is ctrl+slash to xdotool.
KEYSYMS = {'/': 'slash', '\\': 'backslash', '-': 'minus', '=': 'equal', '+': 'plus', ',': 'comma',
           '.': 'period', ';': 'semicolon', "'": 'apostrophe', '[': 'bracketleft', ' ': 'space',
           ']': 'bracketright', '`': 'grave', '_': 'underscore', '<': 'less', '>': 'greater',
           '?': 'question', '!': 'exclam', '@': 'at', '#': 'numbersign', '$': 'dollar',
           '%': 'percent', '^': 'asciicircum', '&': 'ampersand', '*': 'asterisk', ':': 'colon',
           '(': 'parenleft', ')': 'parenright', '"': 'quotedbl', '|': 'bar', '~': 'asciitilde',
           '{': 'braceleft', '}': 'braceright'}
# Window titles change constantly; the cache keys on the trailing "... - App Name" segment.
SEPARATORS = (' \u2014 ', ' \u2013 ', ' - ', ' | ', ' :: ')

Layout = namedtuple('Layout', 'app model summary labels keys actions')

SYSTEM_PROMPT = """You configure a six-key macro pad whose keys carry tiny 64x32 OLED screens.
The user just focused an application the pad has no preset layout for. Choose the six most useful
keyboard shortcuts for that application and label them for the screens.

Reply with JSON only, in this exact shape:
{"app": "<app name>", "summary": "<one short sentence>", "keys": [
  {"label": "<screen text>", "shortcut": "<combination>", "action": "<what it does>"}
]}

Rules:
- Exactly six entries in "keys". Order is the physical layout: keys 1-3 are the top row,
  keys 4-6 the bottom row. Put the most-used shortcuts on the top row.
- "shortcut" is an X11 combination for `xdotool key`, e.g. "ctrl+s", "ctrl+shift+p", "alt+Left",
  "F5", "super+Up". Modifiers may only be ctrl, alt, shift, super. Name non-character keys with
  their X keysym: Return, Escape, Tab, Left, Right, Up, Down, Page_Up, Page_Down, Home, End, F1-F12.
- Shortcuts must be real defaults of that application on Linux, not invented ones.
- Never choose destructive or irreversible actions: no quit, close, delete, or overwrite.
- "label" is plain ASCII, at most 12 characters, describing the action ("Save", "Find", "New tab").
- No two keys may repeat the same shortcut."""


def find_env():
    """First .env next to the companion, in the project root above it, or in the working directory."""
    for candidate in (HOME / '.env', HOME.parent / '.env', Path.cwd() / '.env'):
        if candidate.is_file():
            return candidate
    return HOME / '.env'


def load_env(path=None):
    """Minimal .env reader: KEY=value lines, optional quotes and # comments."""
    values = {}
    try:
        text = (path or find_env()).read_text()
    except OSError:
        return values
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('export '):
            line = line[7:].lstrip()
        name, separator, value = line.partition('=')
        if not separator:
            continue
        value = value.split(' #')[0].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
            value = value[1:-1]
        values[name.strip()] = value
    return values


def setting(name, default=None, env=None):
    """Process environment wins over .env, so a shell export can override the file."""
    return os.environ.get(name) or (env or {}).get(name) or default


def clean_label(text, limit=LABEL_MAX - 1):
    """ASCII, single-spaced and trimmed. The default limit is the firmware buffer minus its NUL."""
    ascii_only = ''.join(character if 32 <= ord(character) < 127 else ' ' for character in str(text))
    return ' '.join(ascii_only.split())[:limit]


def clean_keys(text):
    """Return an xdotool-safe combination, or None if it is not one."""
    combination = str(text).strip()
    if not combination or len(combination) > 40:
        return None
    if len(combination) > 1 and combination.endswith('+'):
        combination = combination[:-1] + 'plus'  # "ctrl++" means ctrl and the + key.
    parts = [part.strip() for part in combination.split('+')]
    if len(parts) > 4 or any(not part for part in parts):
        return None
    *modifiers, key = parts
    if any(modifier.lower() not in MODIFIERS for modifier in modifiers):
        return None
    if len(key) == 1:
        # xdotool reads a bare uppercase letter as shift+letter, and needs keysym names for symbols.
        key = KEYSYMS.get(key, key.lower())
    if not KEYSYM.match(key):
        return None
    return '+'.join([modifier.lower() for modifier in modifiers] + [key])


def cache_key(identity):
    """Collapse "Sketch | Arduino IDE 2.3" to the app segment so one app costs one request."""
    key = identity.strip()
    for separator in SEPARATORS:
        if separator in key:
            key = key.rsplit(separator, 1)[-1].strip()
    return key.lower() or identity.strip().lower()


def nameable(value):
    """True for a string that names an app, rather than a window id or a placeholder."""
    if not isinstance(value, str):
        return False
    value = value.strip()
    return bool(value) and value.lower() not in IDLE_NAMES and not WINDOW_ID.match(value)


def app_identity(context, name=None):
    """Best-effort identity for whatever Focus.read() reports, preferring the app over a window id."""
    if isinstance(context, dict):
        for field in ('wm_class', 'wmclass', 'window_class', 'class', 'app', 'application',
                      'program', 'instance', 'name', 'title'):
            if nameable(context.get(field)):
                return context[field].strip()
        for value in context.values():  # Any other named field, before falling back to an id.
            if nameable(value):
                return value.strip()
    elif isinstance(context, (list, tuple)):
        for part in context:
            if nameable(part):
                return part.strip()
    elif nameable(context):
        return str(context).strip()
    return name.strip() if nameable(name) else None


def parse_layout(content, identity, model):
    """Validate the model's JSON into a Layout, or raise ValueError."""
    payload = json.loads(content)
    entries = payload.get('keys')
    if not isinstance(entries, list) or len(entries) != KEY_COUNT:
        raise ValueError(f'expected {KEY_COUNT} keys, got {len(entries) if isinstance(entries, list) else "none"}')
    labels, keys, actions = [], [], []
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise ValueError(f'key {index+1} is not an object')
        combination = clean_keys(entry.get('shortcut', ''))
        if combination is None:
            # One unusable shortcut disables that key; the other five are still worth having.
            LOG.warning('Key %d: ignoring unusable shortcut %r', index+1, entry.get('shortcut'))
        labels.append(clean_label(entry.get('label') or combination or '?') or '?')
        keys.append(combination)
        actions.append(clean_label(entry.get('action') or '', 120))
    if sum(1 for combination in keys if combination) < 3:
        raise ValueError('fewer than three usable shortcuts in the reply')
    return Layout(app=clean_label(payload.get('app') or identity, 60), model=model,
                  summary=clean_label(payload.get('summary') or '', 120),
                  labels=tuple(labels), keys=tuple(keys), actions=tuple(actions))


class Oracle:
    """Non-blocking store of generated layouts, keyed by focused-app identity.

    Layouts live in memory only, so each run of the companion asks the model afresh.
    """

    def __init__(self, api_key, model=DEFAULT_MODEL, timeout=20, budget=MAX_REQUESTS,
                 verbose=False, stream=True, reasoning=DEFAULT_REASONING, max_output=MAX_OUTPUT):
        self.api_key, self.model, self.timeout = api_key, model, timeout
        self.budget = self.limit = budget
        self.verbose, self.stream = verbose, stream
        self.reasoning = reasoning if reasoning in REASONING_LEVELS else ''
        self.max_output = max_output
        self.adjustments = {}  # Parameter tweaks this model has asked for, learned from its 400s.
        self.minimal = False   # Last resort when a 400 does not say which parameter is at fault.
        self.lock = threading.Lock()
        self.layouts = {}
        self.pending = set()
        self.retry_at = {}
        self.next_request = 0

    @classmethod
    def from_env(cls, env_file=None):
        """Build an Oracle from .env, or return None with the reason logged."""
        env_file = Path(env_file) if env_file else find_env()
        env = load_env(env_file)
        api_key = setting('OPENAI_API_KEY', env=env)
        if not api_key:
            LOG.warning('No OPENAI_API_KEY in %s; unknown apps stay disabled', env_file)
            return None
        model = setting('OPENAI_MODEL', DEFAULT_MODEL, env)
        try:
            timeout = float(setting('OPENAI_TIMEOUT', '20', env))
        except ValueError:
            timeout = 20
        try:
            budget = int(setting('OPENAI_MAX_REQUESTS', str(MAX_REQUESTS), env))
        except ValueError:
            budget = MAX_REQUESTS
        def enabled(name, default):
            value = setting(name, '', env).strip().lower()
            return default if not value else value not in ('0', 'false', 'no', 'off')
        try:
            max_output = int(setting('OPENAI_MAX_OUTPUT_TOKENS', str(MAX_OUTPUT), env))
        except ValueError:
            max_output = MAX_OUTPUT
        reasoning = setting('OPENAI_REASONING', DEFAULT_REASONING, env).strip().lower()
        if reasoning in ('', 'default', 'model'):
            reasoning = ''  # Send nothing and let the model decide.
        elif reasoning not in REASONING_LEVELS:
            LOG.warning('OPENAI_REASONING=%s is not one of %s; leaving it to the model',
                        reasoning, ', '.join(REASONING_LEVELS))
            reasoning = ''
        LOG.info('Generated layouts enabled using %s (key from %s)%s', model, env_file,
                 f', reasoning_effort={reasoning}' if reasoning else '')
        return cls(api_key, model, timeout=timeout, budget=budget, reasoning=reasoning,
                   max_output=max_output, verbose=enabled('OPENAI_VERBOSE', False),
                   stream=enabled('OPENAI_STREAM', True))

    def layout_for(self, identity, context=None):
        """Return this run's layout for the app, starting a lookup the first time it is seen."""
        key = cache_key(identity)
        now = time.monotonic()
        with self.lock:
            layout = self.layouts.get(key)
            if layout is not None or key in self.pending:
                return layout
            if now < self.retry_at.get(key, 0) or now < self.next_request:
                return None
            if self.budget <= 0:
                if self.budget == 0:
                    LOG.warning('Reached the %d-request session budget; no more layouts will be '
                                'generated until restart', self.limit)
                self.budget = -1
                return None
            self.budget -= 1
            self.next_request = now + MIN_INTERVAL
            self.pending.add(key)
        threading.Thread(target=self.fetch, args=(key, identity, context), daemon=True,
                         name=f'llm-{key[:16]}').start()
        return None

    def waiting(self, identity):
        """True while a lookup for this app is in flight, so the keys can show a spinner."""
        with self.lock:
            return cache_key(identity) in self.pending

    def forget(self, identity):
        """Drop a layout so the next focus regenerates it."""
        key = cache_key(identity)
        with self.lock:
            self.layouts.pop(key, None)
            self.retry_at.pop(key, None)

    def build_body(self, messages):
        """The request, with whatever parameter renames or removals this model has demanded."""
        body = {'model': self.model, 'messages': messages, 'temperature': 0.2,
                'max_tokens': self.max_output, 'response_format': {'type': 'json_object'}}
        if self.reasoning:
            body['reasoning_effort'] = self.reasoning
        if self.stream:
            body['stream'] = True
            body['stream_options'] = {'include_usage': True}
        for parameter, replacement in self.adjustments.items():
            if parameter in body:
                value = body.pop(parameter)
                if replacement:
                    body[replacement] = value
        if self.minimal:
            for parameter in ('temperature', 'max_tokens', 'max_completion_tokens',
                              'reasoning_effort'):
                body.pop(parameter, None)
        if 'stream' not in body:
            body.pop('stream_options', None)  # Meaningless, and rejected, without stream.
        return body

    def adapt(self, body, detail):
        """Act on a 400 that names the parameter it dislikes. True if the retry is worth making.

        Adjustments stick for the rest of the run, so only the first lookup pays for discovering
        that this model spells max_tokens differently.
        """
        try:
            error = (json.loads(detail) or {}).get('error') or {}
        except ValueError:
            error = {}
        parameter = error.get('param')
        if parameter == 'reasoning_effort' and REASONING_FALLBACK.get(self.reasoning):
            LOG.info('%s rejected reasoning_effort=%s; trying %s instead',
                     self.model, self.reasoning, REASONING_FALLBACK[self.reasoning])
            self.reasoning = REASONING_FALLBACK[self.reasoning]
            return True
        if parameter and parameter in body and parameter not in self.adjustments:
            replacement = PARAMETER_RENAMES.get(parameter)
            if replacement and replacement in body:
                replacement = None
            self.adjustments[parameter] = replacement
            LOG.info('%s wants %s for the rest of this run', self.model,
                     f'{replacement} instead of {parameter}' if replacement else f'no {parameter}')
            return True
        if not self.minimal:
            LOG.info('%s rejected the request without naming a usable parameter (%s); retrying '
                     'with only the essentials', self.model, detail[:200])
            self.minimal = True
            return True
        return False

    def request(self, identity, context):
        """POST to the API; return the assistant message and whether it was streamed live."""
        described = json.dumps(context, default=str)[:600] if context else identity
        messages = [{'role': 'system', 'content': SYSTEM_PROMPT},
                    {'role': 'user', 'content':
                     f'Focused application: {identity}\nX11 focus details: {described}\n'
                     'Give the six best shortcuts for this application.'}]
        for attempt in range(6):  # Each 400 that names a parameter buys one more attempt.
            body = self.build_body(messages)
            streaming = bool(body.get('stream'))
            if self.verbose:
                LOG.info('LLM request to %s:\n%s', ENDPOINT, json.dumps(body, indent=1))
            elif streaming and attempt == 0:
                self.show_input(messages)
            try:
                if streaming:
                    return self.post_stream(body), True
                return self.post(body), False
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode('utf-8', 'replace')[:600]
                if exc.code == 400 and attempt < 5 and self.adapt(body, detail):
                    continue
                raise RuntimeError(f'HTTP {exc.code}: {detail}') from exc
        raise RuntimeError(f'{self.model} rejected every parameter combination tried')

    def open(self, body):
        request = urllib.request.Request(
            ENDPOINT, data=json.dumps(body).encode('utf-8'),
            headers={'Authorization': f'Bearer {self.api_key}', 'Content-Type': 'application/json'})
        return urllib.request.urlopen(request, timeout=self.timeout)

    def show_input(self, messages):
        """Print the exact prompt being sent, message by message."""
        with STREAM_LOCK:
            STREAM.write(f'\n===== LLM input ({self.model}) =====\n')
            for message in messages:
                STREAM.write(f"--- {message['role']} ---\n{message['content']}\n")
            STREAM.flush()

    def report(self, usage, model, finish):
        # Reasoning models bill hidden thinking inside completion_tokens; show it when reported.
        completion = usage.get('completion_tokens_details') or {}
        prompt = usage.get('prompt_tokens_details') or {}
        extras = [f'{completion[field]} {name}' for field, name in
                  (('reasoning_tokens', 'reasoning'), ('accepted_prediction_tokens', 'predicted'))
                  if completion.get(field)]
        if prompt.get('cached_tokens'):
            extras.append(f"{prompt['cached_tokens']} cached prompt")
        LOG.info('LLM tokens: %s in + %s out = %s total (%s)%s',
                 usage.get('prompt_tokens', '?'), usage.get('completion_tokens', '?'),
                 usage.get('total_tokens', '?'), model,
                 f" [of which {', '.join(extras)}]" if extras else '')
        if finish and finish != 'stop':
            LOG.warning('Model stopped with finish_reason=%s; the reply may be truncated. Raise '
                        'max_tokens or use a different model.', finish)

    def extract(self, payload):
        """Pull the message out of one complete (non-streamed) response body."""
        if self.verbose:
            LOG.info('LLM raw response:\n%s', json.dumps(payload, indent=1))
        choices = payload.get('choices') or []
        if not choices:
            raise RuntimeError(f'no choices in response: {json.dumps(payload)[:300]}')
        self.report(payload.get('usage') or {}, payload.get('model', self.model),
                    choices[0].get('finish_reason'))
        return choices[0].get('message', {}).get('content') or ''

    def post(self, body):
        with self.open(body) as response:
            return self.extract(json.loads(response.read().decode('utf-8')))

    def post_stream(self, body):
        """Stream the completion, printing each delta as it arrives.

        One lookup holds STREAM_LOCK for its whole reply, so two apps looked up at once cannot
        interleave their text. `stream_options` asks for the usage totals in the final chunk.
        """
        pieces, usage, model, finish, plain = [], {}, self.model, None, []
        with self.open(body) as response, STREAM_LOCK:
            STREAM.write('--- assistant (streaming) ---\n')
            for raw in response:
                line = raw.decode('utf-8', 'replace').strip()
                if not line.startswith('data:'):
                    plain.append(line)
                    continue
                data = line[len('data:'):].strip()
                if data == '[DONE]':
                    break
                try:
                    chunk = json.loads(data)
                except ValueError:
                    continue
                if self.verbose:
                    LOG.debug('chunk: %s', data)
                usage = chunk.get('usage') or usage
                model = chunk.get('model') or model
                for choice in chunk.get('choices') or []:
                    piece = (choice.get('delta') or {}).get('content') or ''
                    if piece:
                        pieces.append(piece)
                        STREAM.write(piece)
                        STREAM.flush()
                    finish = choice.get('finish_reason') or finish
            content = ''.join(pieces)
            if not content:
                # Some gateways ignore `stream` and answer with one ordinary JSON body instead.
                try:
                    payload = json.loads('\n'.join(plain))
                except ValueError:
                    raise RuntimeError('stream produced no content') from None
                content = self.extract(payload)
                STREAM.write(content)
                STREAM.write('\n===== end of reply (not streamed by the server) =====\n')
                STREAM.flush()
                return content
            STREAM.write('\n===== end of stream =====\n')
            STREAM.flush()
        self.report(usage, model, finish)
        return content

    def fetch(self, key, identity, context):
        LOG.info('No preset for "%s"; asking %s for shortcuts', identity, self.model)
        if WINDOW_ID.match(identity):
            LOG.warning('Focus only reported a window id, so the model has little to go on. '
                        'Run --watch to see what your X11 focus reports for this app.')
        started = time.monotonic()
        try:
            content, streamed = self.request(identity, context)
            if streamed:  # Already shown live; do not print the same reply twice.
                LOG.info('LLM reply for "%s" complete in %.1fs', identity, time.monotonic() - started)
            else:
                LOG.info('LLM response for "%s" (%.1fs):\n%s', identity,
                         time.monotonic() - started, content.strip())
            layout = parse_layout(content, identity, self.model)
        except (RuntimeError, ValueError, OSError, urllib.error.URLError) as exc:
            LOG.warning('Shortcut generation failed for "%s": %s', identity, exc)
            with self.lock:
                self.pending.discard(key)
                self.retry_at[key] = time.monotonic() + RETRY_AFTER
            return
        with self.lock:
            self.layouts[key] = layout
            self.pending.discard(key)
        LOG.info('Generated layout for %s%s', layout.app, f' - {layout.summary}' if layout.summary else '')
        for index, (label, combination, action) in enumerate(
                zip(layout.labels, layout.keys, layout.actions)):
            LOG.info('  key %d: %-14s %-18s %s', index + 1, label,
                     combination or '(disabled)', action)
