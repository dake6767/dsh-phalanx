"""Redact secret values from failed-install diagnostics before public upload.

Lines are kept so the failing unit, exec phase and exit status stay readable;
only values that can carry a secret are replaced. Usage: redact-diagnostics.py SOURCE TARGET
"""
import re
import sys

REDACTED = '[REDACTED]'
NAMES = r'(?:key|secret|credential|password|token|authorization|cookie|fingerprint)'


def redact(text):
    text = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', text)
    text = re.sub(r'(?i)(https?://)[^\s/@"\']+@', r'\1'+REDACTED+'@', text)
    text = re.sub(r'(?i)https?://[^\s"\']*/bootstrap[^\s"\']*', REDACTED+' initialization link', text)
    text = re.sub(r'(?i)(https?://[^\s"\'?#]*)[?#][^\s"\']*', r'\1?'+REDACTED, text)
    text = re.sub(r'(?i)(postgres(?:ql)?://)[^\s"\']+', r'\1'+REDACTED, text)
    text = re.sub(r'(?i)\b((?:proxy-)?authorization|(?:set-)?cookie)(["\']?\s*[:=]\s*).*$', r'\1\2'+REDACTED, text, flags=re.M)
    # NAME=value, NAME: value and "name": "value"; file paths and flag names stay readable.
    text = re.sub(r'(?i)((?<![/\w.-])[a-z0-9_.-]*' + NAMES + r'[a-z0-9_.-]*["\']?\s*[:=]\s*["\']?)(?!/|%t/|\[REDACTED)([^\s"\',}]+)', r'\1'+REDACTED, text)
    text = re.sub(r'(?i)(--[a-z0-9-]*' + NAMES + r'[a-z0-9-]*(?:=|\s+))(?!/|%t/|-)([^\s"\']+)', r'\1'+REDACTED, text)
    text = re.sub(r'(?i)\b(bearer|basic)\s+[a-z0-9+/._~=-]{8,}', r'\1 '+REDACTED, text)
    text = re.sub(r'(?i)(fingerprint\W+)sha256:[a-f0-9]{64}', r'\1'+REDACTED, text)
    return text


if __name__ == '__main__':
    source, target = sys.argv[1:3]
    with open(source, encoding='utf-8', errors='replace') as file: content = file.read()
    with open(target, 'w', encoding='utf-8') as file: file.write(redact(content))
