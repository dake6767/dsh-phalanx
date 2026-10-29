"""Bounded physical secret scanning and the declared container runtime alias."""
import base64
import pathlib
import re


def secret_needles(secrets):
    needles = []
    seen = set()
    for name, value in secrets:
        if not isinstance(value, bytes) or not value:
            raise ValueError('Secret scan requires nonempty byte values')
        for representation in (value, value.hex().encode(), base64.b64encode(value), base64.urlsafe_b64encode(value).rstrip(b'=')):
            if representation not in seen:
                seen.add(representation)
                needles.append((name, representation))
    if not needles:
        raise ValueError('Secret scan requires known values')
    return needles


def scan_secret_file(path, needles, chunk_size=65536):
    if chunk_size < 1 or not needles:
        raise ValueError('Invalid physical scan configuration')
    overlap = max(len(value) for _, value in needles) - 1
    total, tail, found = 0, b'', set()
    with pathlib.Path(path).open('rb') as source:
        while chunk := source.read(chunk_size):
            total += len(chunk)
            window = tail + chunk
            found.update(name for name, value in needles if value in window)
            tail = window[-overlap:] if overlap else b''
    return total, found


def runtime_projection_target(link, data, uid):
    """Resolve only the member projection of the declared immutable runtime tree."""
    link, data = pathlib.Path(link), pathlib.Path(data)
    if not link.is_symlink() or link.exists() or not link.is_relative_to(data / 'skills/members'):
        return None
    text = str(link.readlink())
    if not re.fullmatch(r'/dsh-phalanx/runtime-dependencies/\.trees/[a-f0-9]{64}/bin/[a-zA-Z0-9_-]+', text):
        return None
    target = (data / text.removeprefix('/dsh-phalanx/')).resolve(strict=True)
    if not target.is_relative_to((data / 'runtime-dependencies/.trees').resolve(strict=True)):
        raise ValueError('Runtime link escapes its declared artifact tree')
    if not target.is_file() or target.stat().st_uid != uid:
        raise ValueError('Runtime target ownership or type differs')
    return target
